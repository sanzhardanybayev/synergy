import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ReviewFreshnessAsyncError,
  type ReviewFreshnessWorker,
  type ReviewFreshnessWorkerFactory,
  compareReviewSourceFreshnessAsync,
} from '../src/index.js';

const SNAPSHOT = {
  source: { kind: 'staged' as const, headSha: 'abc123' },
  fingerprint: 'fingerprint-a',
};

class FakeWorker implements ReviewFreshnessWorker {
  private messageListener: ((message: unknown) => void) | undefined;
  private errorListener: ((error: Error) => void) | undefined;
  private exitListener: ((code: number) => void) | undefined;
  terminated = false;

  onMessage(listener: (message: unknown) => void): void {
    this.messageListener = listener;
  }

  onError(listener: (error: Error) => void): void {
    this.errorListener = listener;
  }

  onExit(listener: (code: number) => void): void {
    this.exitListener = listener;
  }

  terminate(): void {
    this.terminated = true;
  }

  message(message: unknown): void {
    this.messageListener?.(message);
  }

  error(error: Error): void {
    this.errorListener?.(error);
  }

  exit(code: number): void {
    this.exitListener?.(code);
  }
}

function factory(worker: FakeWorker): ReviewFreshnessWorkerFactory {
  return () => worker;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('async review source freshness', () => {
  it('returns the exact worker result without blocking the caller turn', async () => {
    const worker = new FakeWorker();
    let settled = false;
    const resultPromise = compareReviewSourceFreshnessAsync(SNAPSHOT, '/repo', {
      workerFactory: factory(worker),
    });
    void resultPromise.then(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(settled).toBe(false);
    worker.message({
      ok: true,
      result: { sourceChanged: true, captureFailed: false },
    });

    await expect(resultPromise).resolves.toEqual({ sourceChanged: true, captureFailed: false });
    expect(worker.terminated).toBe(true);
  });

  it('terminates and rejects with a typed sanitized timeout', async () => {
    vi.useFakeTimers();
    const worker = new FakeWorker();
    const resultPromise = compareReviewSourceFreshnessAsync(SNAPSHOT, '/repo', {
      timeoutMs: 25,
      workerFactory: factory(worker),
    });
    const rejection = expect(resultPromise).rejects.toMatchObject({ code: 'freshness_timeout' });

    await vi.advanceTimersByTimeAsync(25);
    await rejection;
    expect(worker.terminated).toBe(true);
  });

  it('terminates and rejects with a typed sanitized abort', async () => {
    const worker = new FakeWorker();
    const controller = new AbortController();
    const resultPromise = compareReviewSourceFreshnessAsync(SNAPSHOT, '/repo', {
      signal: controller.signal,
      workerFactory: factory(worker),
    });
    controller.abort();

    await expect(resultPromise).rejects.toMatchObject({ code: 'freshness_aborted' });
    expect(worker.terminated).toBe(true);
  });

  it.each([
    {
      label: 'worker error',
      trigger: (worker: FakeWorker) => worker.error(new Error('sensitive worker detail')),
    },
    { label: 'premature worker exit', trigger: (worker: FakeWorker) => worker.exit(9) },
  ])('sanitizes $label failures', async ({ trigger }) => {
    const worker = new FakeWorker();
    const resultPromise = compareReviewSourceFreshnessAsync(SNAPSHOT, '/repo', {
      workerFactory: factory(worker),
    });
    trigger(worker);

    let thrown: unknown;
    try {
      await resultPromise;
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ReviewFreshnessAsyncError);
    expect(thrown).toMatchObject({ code: 'freshness_worker_failed' });
    expect((thrown as Error).message).not.toContain('sensitive worker detail');
    expect(worker.terminated).toBe(true);
  });

  it('sanitizes a worker startup failure', async () => {
    const resultPromise = compareReviewSourceFreshnessAsync(SNAPSHOT, '/repo', {
      workerFactory: () => {
        throw new Error('sensitive startup detail');
      },
    });

    await expect(resultPromise).rejects.toMatchObject({ code: 'freshness_worker_failed' });
  });
});
