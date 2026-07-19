import { watch } from 'node:fs';
import {
  reconcileExpiredQuestions,
  removeReviewListener,
  reviewQuestionsDirectory,
  touchReviewListener,
} from '@synergy/review-core';
import type { ReviewQuestion, ReviewRef } from '@synergy/review-core';

const LISTENER_HEARTBEAT_MS = 30_000;
const WATCH_DEBOUNCE_MS = 60;

export interface ReviewWaitResult {
  status: 'questions' | 'timeout';
  listenerId: string;
  questions: ReviewQuestion[];
}

export interface ReviewWaitOptions {
  root: string;
  reference: ReviewRef;
  listenerId: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  watchImpl?: typeof watch;
  /** Test seams for deterministic watcher and timeout-boundary coverage. */
  scanQuestions?: (root: string, reference: ReviewRef) => ReviewQuestion[];
  touchListener?: (root: string, reference: ReviewRef, listenerId: string) => void;
  removeListener?: (root: string, reference: ReviewRef, listenerId: string) => void;
  heartbeatMs?: number;
  beforeTimeoutScan?: () => void;
}

function retryableQuestions(root: string, reference: ReviewRef): ReviewQuestion[] {
  return reconcileExpiredQuestions(root, reference).filter(
    (question) => question.status === 'queued' || question.status === 'failed',
  );
}

/**
 * Watches durable question files. Every exit path clears timers and presence;
 * all scan failures reject so callers can report a real foreground failure.
 */
export function waitForReviewQuestions(options: ReviewWaitOptions): Promise<ReviewWaitResult> {
  const {
    root,
    reference,
    listenerId,
    timeoutMs,
    signal,
    watchImpl = watch,
    scanQuestions = retryableQuestions,
    touchListener = touchReviewListener,
    removeListener = removeReviewListener,
    heartbeatMs = LISTENER_HEARTBEAT_MS,
    beforeTimeoutScan,
  } = options;
  const directory = reviewQuestionsDirectory(root, reference);
  let presenceTouched = false;
  try {
    touchListener(root, reference, listenerId);
    presenceTouched = true;
    const queued = scanQuestions(root, reference);
    if (queued.length > 0) {
      removeListener(root, reference, listenerId);
      return Promise.resolve({ status: 'questions', listenerId, questions: queued });
    }
  } catch (error) {
    if (presenceTouched) {
      try {
        removeListener(root, reference, listenerId);
      } catch {
        // The original persistence failure remains the actionable error.
      }
    }
    return Promise.reject(error);
  }

  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    let debounce: ReturnType<typeof setTimeout> | undefined;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let watcher: ReturnType<typeof watch> | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;

    const cleanup = () => {
      if (debounce) clearTimeout(debounce);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (heartbeat) clearInterval(heartbeat);
      signal?.removeEventListener('abort', onAbort);
      try {
        watcher?.close();
      } catch {
        // Cleanup must continue to remove presence even if a watcher already closed.
      }
      try {
        removeListener(root, reference, listenerId);
      } catch {
        // The terminal result/error is more useful than a cleanup failure.
      }
    };

    const finish = (result: ReviewWaitResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolvePromise(result);
    };

    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectPromise(error instanceof Error ? error : new Error(String(error)));
    };

    const check = () => {
      try {
        const questions = scanQuestions(root, reference);
        if (questions.length > 0) finish({ status: 'questions', listenerId, questions });
      } catch (error) {
        fail(error);
      }
    };

    const schedule = () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(check, WATCH_DEBOUNCE_MS);
    };

    const onAbort = () => finish({ status: 'timeout', listenerId, questions: [] });
    const onTimeout = () => {
      if (debounce) clearTimeout(debounce);
      try {
        beforeTimeoutScan?.();
        const questions = scanQuestions(root, reference);
        finish(
          questions.length > 0
            ? { status: 'questions', listenerId, questions }
            : { status: 'timeout', listenerId, questions: [] },
        );
      } catch (error) {
        fail(error);
      }
    };

    try {
      watcher = watchImpl(directory, (_event, filename) => {
        if (filename?.toString().startsWith('.listeners')) return;
        schedule();
      });
      watcher.on('error', fail);
      heartbeat = setInterval(() => {
        try {
          touchListener(root, reference, listenerId);
          check();
        } catch (error) {
          fail(error);
        }
      }, heartbeatMs);
      heartbeat.unref?.();
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      if (timeoutMs !== undefined) timeoutTimer = setTimeout(onTimeout, timeoutMs);
      schedule();
    } catch (error) {
      fail(error);
    }
  });
}
