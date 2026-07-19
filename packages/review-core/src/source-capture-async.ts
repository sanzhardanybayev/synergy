import { Worker } from 'node:worker_threads';
import type { CapturedReviewSource, ReviewSourceFreshness } from './source-capture.js';

const DEFAULT_FRESHNESS_TIMEOUT_MS = 30_000;

export type ReviewFreshnessAsyncErrorCode =
  | 'freshness_aborted'
  | 'freshness_timeout'
  | 'freshness_worker_failed';

export class ReviewFreshnessAsyncError extends Error {
  constructor(readonly code: ReviewFreshnessAsyncErrorCode) {
    super(
      code === 'freshness_aborted'
        ? 'review source freshness check was aborted'
        : code === 'freshness_timeout'
          ? 'review source freshness check timed out'
          : 'review source freshness worker failed',
    );
    this.name = 'ReviewFreshnessAsyncError';
  }
}

export interface ReviewFreshnessWorkerData {
  snapshot: Pick<CapturedReviewSource, 'source' | 'fingerprint'>;
  root: string;
}

export interface ReviewFreshnessWorker {
  onMessage(listener: (message: unknown) => void): void;
  onError(listener: (error: Error) => void): void;
  onExit(listener: (code: number) => void): void;
  terminate(): void;
}

export interface ReviewFreshnessWorkerInput {
  url: URL;
  data: ReviewFreshnessWorkerData;
}

export type ReviewFreshnessWorkerFactory = (
  input: ReviewFreshnessWorkerInput,
) => ReviewFreshnessWorker;

export interface ReviewSourceFreshnessAsyncOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  workerFactory?: ReviewFreshnessWorkerFactory;
}

interface ReviewFreshnessWorkerSuccess {
  ok: true;
  result: ReviewSourceFreshness;
}

function isWorkerSuccess(message: unknown): message is ReviewFreshnessWorkerSuccess {
  if (typeof message !== 'object' || message === null || !('ok' in message)) return false;
  if (message.ok !== true || !('result' in message)) return false;
  const result = message.result;
  return (
    typeof result === 'object' &&
    result !== null &&
    'sourceChanged' in result &&
    typeof result.sourceChanged === 'boolean' &&
    'captureFailed' in result &&
    typeof result.captureFailed === 'boolean'
  );
}

const defaultWorkerFactory: ReviewFreshnessWorkerFactory = ({ url, data }) => {
  const worker = new Worker(url, { workerData: data });
  return {
    onMessage: (listener) => worker.once('message', listener),
    onError: (listener) => worker.once('error', listener),
    onExit: (listener) => worker.once('exit', listener),
    terminate: () => {
      void worker.terminate();
    },
  };
};

/** Runs the canonical synchronous capture authority outside the caller's event loop. */
export function compareReviewSourceFreshnessAsync(
  snapshot: Pick<CapturedReviewSource, 'source' | 'fingerprint'>,
  root: string,
  options: ReviewSourceFreshnessAsyncOptions = {},
): Promise<ReviewSourceFreshness> {
  if (options.signal?.aborted) {
    return Promise.reject(new ReviewFreshnessAsyncError('freshness_aborted'));
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_FRESHNESS_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return Promise.reject(new ReviewFreshnessAsyncError('freshness_timeout'));
  }
  let worker: ReviewFreshnessWorker;
  try {
    worker = (options.workerFactory ?? defaultWorkerFactory)({
      url: new URL('./source-capture-worker.js', import.meta.url),
      data: { snapshot, root },
    });
  } catch {
    return Promise.reject(new ReviewFreshnessAsyncError('freshness_worker_failed'));
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const timing: { timeout?: ReturnType<typeof setTimeout> } = {};
    const cleanup = (): void => {
      if (timing.timeout !== undefined) clearTimeout(timing.timeout);
      options.signal?.removeEventListener('abort', handleAbort);
      worker.terminate();
    };
    const rejectOnce = (code: ReviewFreshnessAsyncErrorCode): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new ReviewFreshnessAsyncError(code));
    };
    const handleAbort = (): void => rejectOnce('freshness_aborted');

    worker.onMessage((message) => {
      if (settled) return;
      if (!isWorkerSuccess(message)) {
        rejectOnce('freshness_worker_failed');
        return;
      }
      settled = true;
      cleanup();
      resolve(message.result);
    });
    worker.onError(() => rejectOnce('freshness_worker_failed'));
    worker.onExit(() => rejectOnce('freshness_worker_failed'));
    options.signal?.addEventListener('abort', handleAbort, { once: true });
    if (options.signal?.aborted) {
      handleAbort();
      return;
    }
    timing.timeout = setTimeout(() => rejectOnce('freshness_timeout'), timeoutMs);
  });
}
