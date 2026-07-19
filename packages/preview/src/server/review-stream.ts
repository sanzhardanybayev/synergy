import { createHash } from 'node:crypto';
import { existsSync, watch as nodeWatch } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  type ReviewAnswer,
  type ReviewProgress,
  type ReviewQuestion,
  type ReviewReadiness,
  type ReviewRef,
  compareReviewSourceFreshnessAsync,
  createReviewStore,
  isReviewCoreError,
  reviewRevisionDir,
  reviewWorkspaceDir,
} from '@synergy/review-core';
import { sendJson } from './http.js';
import { REVIEW_LISTENER_STALE_MS, readReviewListenerPresence } from './review-presence.js';
import {
  type AuthoritativeReviewState,
  REVIEW_FRESHNESS_TIMEOUT_MS,
  ReviewStatePublisher,
} from './review-stream-state.js';
import { ReviewStreamWriter } from './review-stream-writer.js';

const DEBOUNCE_MS = 80;
const KEEPALIVE_MS = 25_000;
const SOURCE_POLL_MS = 5_000;
const MAX_QUEUED_RECORDS = 512;

export type ReviewStreamFrame =
  | { type: 'presence'; listening: boolean }
  | { type: 'question'; question: ReviewQuestion }
  | { type: 'answer'; answer: ReviewAnswer }
  | {
      type: 'progress';
      progress: ReviewProgress;
      readiness: ReviewReadiness;
      analysisFinalized: boolean;
    }
  | { type: 'source'; changed: boolean; captureFailed: boolean }
  | {
      type: 'interruption';
      code: 'source_capture_failed' | 'stream_unavailable' | 'review_unavailable';
      recoverable: boolean;
    };

export interface ReviewStreamWatcher {
  close(): void;
  on?(event: 'error', listener: (error?: Error) => void): void;
}

export interface ReviewStreamEnvironment {
  watch(
    path: string,
    listener: (filename: string | Buffer | null) => void,
    options?: { recursive: boolean },
  ): ReviewStreamWatcher;
  setTimeout(callback: () => void, delay: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
  setInterval(callback: () => void, delay: number): ReturnType<typeof setInterval>;
  clearInterval(timer: ReturnType<typeof setInterval>): void;
  now?(): number;
  compareSourceFreshnessAsync?: typeof compareReviewSourceFreshnessAsync;
  freshnessTimeoutMs?: number;
  write?: (response: ServerResponse, chunk: string) => boolean;
  maxQueuedRecords?: number;
}

const DEFAULT_ENVIRONMENT: ReviewStreamEnvironment = {
  watch: (path, listener, options = { recursive: false }) => {
    const watcher = nodeWatch(path, options, (_event, filename) => listener(filename));
    return watcher;
  },
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  now: Date.now,
  compareSourceFreshnessAsync: compareReviewSourceFreshnessAsync,
  freshnessTimeoutMs: REVIEW_FRESHNESS_TIMEOUT_MS,
};

interface ReviewStreamResources {
  writer?: ReviewStreamWriter;
  keepaliveTimer?: ReturnType<typeof setInterval>;
  sourcePollTimer?: ReturnType<typeof setInterval>;
  freshnessController?: AbortController;
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}

function streamErrorStatus(error: unknown): { status: number; code: string } {
  if (!isReviewCoreError(error)) return { status: 500, code: 'internal_error' };
  if (error.code === 'review_not_found') return { status: 404, code: error.code };
  if (error.code === 'review_conflict') return { status: 409, code: error.code };
  if (error.code === 'review_corrupt') return { status: 422, code: error.code };
  return { status: 423, code: error.code };
}

function normalizedFilename(filename: string | Buffer | null): string | null | undefined {
  if (filename === null) return null;
  const normalized = filename.toString().replaceAll('\\', '/');
  if (normalized.length === 0) return null;
  if (normalized.startsWith('/') || normalized.split('/').some((segment) => segment === '..')) {
    return undefined;
  }
  return normalized;
}

/** Streams one immutable review revision with replay, freshness, and bounded delivery. */
export async function handleReviewStream(
  req: IncomingMessage,
  res: ServerResponse,
  projectRoot: string,
  reference: ReviewRef,
  environment: ReviewStreamEnvironment = DEFAULT_ENVIRONMENT,
): Promise<void> {
  const now = (): number => (environment.now ?? Date.now).call(environment);
  const workspaceDirectory = reviewWorkspaceDir(projectRoot, reference.workspaceId);
  const revisionDirectory = reviewRevisionDir(
    projectRoot,
    reference.workspaceId,
    reference.revisionId,
  );
  const watchers: ReviewStreamWatcher[] = [];
  let started = false;
  let closed = false;
  let lifecycleAttached = false;
  let startupWatcherFailed = false;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let presenceExpiryTimer: ReturnType<typeof setTimeout> | undefined;
  const resources: ReviewStreamResources = {};
  let pendingState = false;
  let pendingPresence = false;
  let lastPresence: boolean | undefined;
  let refreshInFlight = false;
  let refreshPending = false;

  const closeWatchers = (): void => {
    for (const watcher of watchers) {
      try {
        watcher.close();
      } catch {
        // Continue closing the remaining stream resources.
      }
    }
  };
  const removeLifecycleListeners = (): void => {
    if (!lifecycleAttached) return;
    lifecycleAttached = false;
    req.off('close', onRequestClose);
    req.off('aborted', onRequestAbort);
    res.off('close', onResponseClose);
    res.off('error', onResponseError);
    res.off('finish', onResponseFinish);
    res.off('drain', onDrain);
  };
  const terminate = (endResponse: boolean): void => {
    if (closed) return;
    closed = true;
    if (debounceTimer) environment.clearTimeout(debounceTimer);
    if (presenceExpiryTimer) environment.clearTimeout(presenceExpiryTimer);
    if (resources.keepaliveTimer) environment.clearInterval(resources.keepaliveTimer);
    if (resources.sourcePollTimer) environment.clearInterval(resources.sourcePollTimer);
    resources.freshnessController?.abort();
    resources.freshnessController = undefined;
    closeWatchers();
    resources.writer?.close();
    removeLifecycleListeners();
    if (endResponse && !res.writableEnded && !res.destroyed) {
      try {
        res.end();
      } catch {
        // The response side already failed; all stream resources are still closed.
      }
    }
  };
  function onRequestClose(): void {
    terminate(true);
  }
  function onRequestAbort(): void {
    terminate(true);
  }
  function onResponseClose(): void {
    terminate(false);
  }
  function onResponseError(): void {
    terminate(false);
  }
  function onResponseFinish(): void {
    terminate(false);
  }
  function onDrain(): void {
    resources.writer?.drain();
  }

  const sendState = (key: string, frame: ReviewStreamFrame): void => {
    resources.writer?.sendState(key, {
      event: frame.type,
      id: `${key}:${digest(frame)}`,
      data: frame,
    });
  };
  const sendRecord = (
    kind: 'question' | 'answer',
    record: ReviewQuestion | ReviewAnswer,
    frame: ReviewStreamFrame,
  ): void => {
    resources.writer?.sendRecord(`${kind}:${record.id}`, {
      event: kind,
      id: `${kind}:${record.id}:${digest(record)}`,
      data: frame,
    });
  };
  const statePublisher = new ReviewStatePublisher({
    projectRoot,
    reference,
    environment,
    sendState,
    sendRecord,
  });

  const refreshPresence = (force: boolean): void => {
    if (closed) return;
    if (presenceExpiryTimer) {
      environment.clearTimeout(presenceExpiryTimer);
      presenceExpiryTimer = undefined;
    }
    const presence = readReviewListenerPresence(projectRoot, reference, now());
    if (force || presence.listening !== lastPresence) {
      lastPresence = presence.listening;
      sendState('presence', { type: 'presence', listening: presence.listening });
    }
    if (presence.nextExpiryAt !== undefined) {
      const delay = Math.max(0, presence.nextExpiryAt - now());
      presenceExpiryTimer = environment.setTimeout(() => {
        presenceExpiryTimer = undefined;
        refreshPresence(false);
      }, delay);
    }
  };

  const refreshState = async (force: boolean): Promise<void> => {
    if (closed) return;
    if (refreshInFlight) {
      refreshPending = true;
      return;
    }
    refreshInFlight = true;
    const controller = new AbortController();
    resources.freshnessController = controller;
    try {
      const state = await statePublisher.read(controller.signal);
      if (closed || controller.signal.aborted) return;
      statePublisher.publish(state, force);
    } catch {
      if (closed || controller.signal.aborted) return;
      sendState('interruption', {
        type: 'interruption',
        code: 'review_unavailable',
        recoverable: false,
      });
      terminate(true);
    } finally {
      if (resources.freshnessController === controller) {
        resources.freshnessController = undefined;
      }
      refreshInFlight = false;
      if (refreshPending && !closed) {
        refreshPending = false;
        void refreshState(false);
      }
    }
  };

  const flush = (): void => {
    debounceTimer = undefined;
    if (closed) return;
    const state = pendingState;
    const presence = pendingPresence;
    pendingState = false;
    pendingPresence = false;
    if (state) void refreshState(false);
    if (presence) refreshPresence(false);
  };
  const schedule = (): void => {
    if (!started || closed) return;
    if (debounceTimer) environment.clearTimeout(debounceTimer);
    debounceTimer = environment.setTimeout(flush, DEBOUNCE_MS);
  };
  const onWorkspaceChange = (filename: string | Buffer | null): void => {
    const name = normalizedFilename(filename);
    if (name === null) {
      pendingState = true;
      schedule();
      return;
    }
    if (name !== 'workspace.json') return;
    pendingState = true;
    schedule();
  };
  const onRevisionChange = (filename: string | Buffer | null): void => {
    const name = normalizedFilename(filename);
    if (name === null) {
      pendingState = true;
      pendingPresence = true;
      schedule();
      return;
    }
    if (name === undefined) return;
    if (name.startsWith('questions/.listeners/')) {
      pendingPresence = true;
    } else if (
      name === 'progress.json' ||
      name === 'snapshot.json' ||
      name === 'bundle.json' ||
      name.startsWith('questions/') ||
      name.startsWith('answers/')
    ) {
      pendingState = true;
    } else {
      return;
    }
    schedule();
  };
  const onWatcherError = (): void => {
    if (!resources.writer) {
      startupWatcherFailed = true;
      resources.freshnessController?.abort();
      return;
    }
    sendState('interruption', {
      type: 'interruption',
      code: 'stream_unavailable',
      recoverable: false,
    });
    terminate(true);
  };

  if (!existsSync(workspaceDirectory) || !existsSync(revisionDirectory)) {
    try {
      createReviewStore(projectRoot).readBundle(reference.workspaceId, reference.revisionId);
    } catch (error) {
      terminate(false);
      const mapped = streamErrorStatus(error);
      sendJson(res, mapped.status, { error: mapped.code });
      return;
    }
  }
  try {
    const workspaceWatcher = environment.watch(workspaceDirectory, onWorkspaceChange, {
      recursive: false,
    });
    workspaceWatcher.on?.('error', onWatcherError);
    watchers.push(workspaceWatcher);
    const revisionWatcher = environment.watch(revisionDirectory, onRevisionChange, {
      recursive: true,
    });
    revisionWatcher.on?.('error', onWatcherError);
    watchers.push(revisionWatcher);
    if (startupWatcherFailed) throw new Error('watcher failed during stream startup');
  } catch (error) {
    terminate(false);
    if (isReviewCoreError(error)) {
      const mapped = streamErrorStatus(error);
      sendJson(res, mapped.status, { error: mapped.code });
    } else {
      sendJson(res, 503, { error: 'stream_unavailable' });
    }
    return;
  }

  req.on('close', onRequestClose);
  req.on('aborted', onRequestAbort);
  res.on('close', onResponseClose);
  res.on('error', onResponseError);
  res.on('finish', onResponseFinish);
  res.on('drain', onDrain);
  lifecycleAttached = true;

  let initialState: AuthoritativeReviewState;
  const initialController = new AbortController();
  resources.freshnessController = initialController;
  try {
    initialState = await statePublisher.read(initialController.signal);
    if (closed) return;
    if (startupWatcherFailed) throw new Error('watcher failed during initial capture');
  } catch (error) {
    if (closed) return;
    terminate(false);
    if (isReviewCoreError(error)) {
      const mapped = streamErrorStatus(error);
      sendJson(res, mapped.status, { error: mapped.code });
    } else {
      sendJson(res, 503, { error: 'stream_unavailable' });
    }
    return;
  } finally {
    if (resources.freshnessController === initialController) {
      resources.freshnessController = undefined;
    }
  }
  try {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
  } catch {
    terminate(false);
    return;
  }
  if (closed) return;

  resources.writer = new ReviewStreamWriter(res, {
    maxQueuedRecords: environment.maxQueuedRecords ?? MAX_QUEUED_RECORDS,
    onFailure: () => terminate(true),
    onOverflow: () => terminate(true),
    write: environment.write,
  });
  refreshPresence(true);
  statePublisher.publish(initialState, true);
  if (closed) return;

  // Authoritative post-attach catch-up. Signatures suppress duplicate replay bursts.
  await refreshState(false);
  if (closed) return;
  refreshPresence(false);
  if (closed) return;
  pendingState = false;
  pendingPresence = false;
  started = true;
  resources.keepaliveTimer = environment.setInterval(
    () => resources.writer?.sendKeepalive(),
    KEEPALIVE_MS,
  );
  resources.sourcePollTimer = environment.setInterval(() => {
    void refreshState(false);
  }, SOURCE_POLL_MS);
}

export {
  DEBOUNCE_MS,
  KEEPALIVE_MS,
  REVIEW_FRESHNESS_TIMEOUT_MS,
  REVIEW_LISTENER_STALE_MS,
  SOURCE_POLL_MS,
};
