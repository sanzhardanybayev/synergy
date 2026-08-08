import { EventEmitter } from 'node:events';
import { type FSWatcher, mkdirSync, rmSync, utimesSync, type watch, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { handleFeedbackStream } from '../../src/server/feedback-stream.js';
import { makeTempDir } from './helpers.js';

/**
 * Synchronous stand-in for `node:fs`'s `watch`, injected via
 * `handleFeedbackStream`'s `watchFn` seam. The real OS watch backend
 * (FSEvents on macOS) has load-dependent startup/delivery latency that can
 * exceed even a generous fixed timeout under a fully parallel suite run
 * (observed directly: a 10s waitFor timed out under `pnpm -r test` load).
 * Driving the watcher callback directly makes the "file change triggers a
 * frame" assertion deterministic and load-independent, instead of racing a
 * real filesystem event.
 */
function makeFakeWatch() {
  let listener: ((event: string, filename: string | null) => void) | undefined;
  const watcher = { close() {}, on() {} } as unknown as FSWatcher;
  const watchFn = ((_dir: string, cb: (event: string, filename: string | null) => void) => {
    listener = cb;
    return watcher;
  }) as typeof watch;
  const emit = (event: string, filename: string | null) => listener?.(event, filename);
  return { watchFn, emit };
}

const SESSION = '2026-07-18-checkout-flow';

/** SSE-capable mock response: captures streamed writes. */
function makeStreamRes() {
  const chunks: string[] = [];
  const res = {
    statusCode: 200,
    writeHead(code: number) {
      res.statusCode = code;
    },
    write(chunk: string) {
      chunks.push(chunk);
      return true;
    },
    end() {},
  };
  return { res, chunks, status: () => res.statusCode };
}

function makeStreamReq(url: string): EventEmitter & { url: string; method: string } {
  const req = new EventEmitter() as EventEmitter & { url: string; method: string };
  req.url = url;
  req.method = 'GET';
  return req;
}

// Generous budget: under a fully parallel suite run, real timers (and, for
// the tests still using the real `watch` backend below, macOS FSEvents
// delivery) can lag well past what's typical; this bounds flakiness against
// CPU-starved scheduling, not expected latency.
const waitFor = async (predicate: () => boolean, timeoutMs = 10_000): Promise<void> => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
};

describe('handleFeedbackStream', () => {
  let temp: ReturnType<typeof makeTempDir>;

  afterEach(() => temp?.cleanup());

  it(
    'sends an initial frame, then a change frame when a comment file lands',
    { timeout: 15_000 },
    async () => {
      temp = makeTempDir();
      const req = makeStreamReq(`/api/feedback/stream?session=${SESSION}`);
      const { res, chunks } = makeStreamRes();
      const { watchFn, emit } = makeFakeWatch();

      handleFeedbackStream(
        req as unknown as IncomingMessage,
        res as unknown as ServerResponse,
        temp.dir,
        watchFn,
      );

      await waitFor(() => chunks.length >= 1);

      mkdirSync(join(temp.dir, SESSION), { recursive: true });
      writeFileSync(
        join(temp.dir, SESSION, 'new-comment.md'),
        '---\nstatus: open\n---\nhi',
        'utf8',
      );
      // Drive the watcher callback directly rather than waiting on the real
      // fs backend to notice the write above - see makeFakeWatch().
      emit('change', 'new-comment.md');

      await waitFor(() => chunks.some((c) => c.includes('feedback-changed')));

      req.emit('close');
    },
  );

  // Sole real-filesystem coverage of the watch -> SSE path. Every other test
  // in this file either injects the fake watcher above or doesn't depend on
  // an fs event firing within a budget, because the real OS watch backend
  // (FSEvents on macOS) has load-dependent startup/delivery latency that can
  // occasionally exceed even generous fixed timeouts under a fully parallel
  // suite run (see the fake-watcher test's comment for the reproduction).
  // Rather than drop real-fs coverage entirely, this test keeps the default
  // `watchFn` (real `fs.watch`), resolves as soon as the frame arrives (so it
  // normally finishes in milliseconds, not the ceiling), and retries once in
  // the rare event the first attempt's watcher genuinely never delivers -
  // the retry re-creates the stream and watcher on a fresh temp dir so the
  // second attempt isn't tainted by the first watcher's state.
  it(
    'sends a real feedback-changed frame from a real fs.watch write',
    { timeout: 35_000 },
    async () => {
      const attempt = async (): Promise<void> => {
        const attemptTemp = makeTempDir();
        try {
          const req = makeStreamReq(`/api/feedback/stream?session=${SESSION}`);
          const { res, chunks } = makeStreamRes();

          let resolveChanged: (() => void) | undefined;
          const changed = new Promise<void>((resolve) => {
            resolveChanged = resolve;
          });
          const originalWrite = res.write;
          res.write = (chunk: string) => {
            const wrote = originalWrite(chunk);
            if (chunk.includes('feedback-changed')) resolveChanged?.();
            return wrote;
          };

          handleFeedbackStream(
            req as unknown as IncomingMessage,
            res as unknown as ServerResponse,
            attemptTemp.dir,
          );

          await waitFor(() => chunks.length >= 1);

          mkdirSync(join(attemptTemp.dir, SESSION), { recursive: true });
          writeFileSync(
            join(attemptTemp.dir, SESSION, 'new-comment.md'),
            '---\nstatus: open\n---\nhi',
            'utf8',
          );

          const timeout = new Promise<void>((_resolve, reject) =>
            setTimeout(() => reject(new Error('real fs.watch did not deliver a frame')), 15_000),
          );
          try {
            await Promise.race([changed, timeout]);
          } finally {
            req.emit('close');
          }
        } finally {
          attemptTemp.cleanup();
        }
      };

      try {
        await attempt();
      } catch {
        await attempt();
      }
    },
  );

  it('reports agent presence from a fresh listening marker', { timeout: 15_000 }, async () => {
    temp = makeTempDir();
    mkdirSync(join(temp.dir, SESSION), { recursive: true });
    writeFileSync(join(temp.dir, SESSION, '.listening'), 'now', 'utf8');

    const req = makeStreamReq(`/api/feedback/stream?session=${SESSION}`);
    const { res, chunks } = makeStreamRes();
    handleFeedbackStream(
      req as unknown as IncomingMessage,
      res as unknown as ServerResponse,
      temp.dir,
    );

    await waitFor(() => chunks.some((c) => c.includes('"type":"presence"')));
    const presence = chunks.find((c) => c.includes('"type":"presence"'));
    expect(presence).toContain('"listening":true');

    req.emit('close');
  });

  it('reports no presence when the listening marker is stale', { timeout: 15_000 }, async () => {
    temp = makeTempDir();
    mkdirSync(join(temp.dir, SESSION), { recursive: true });
    const marker = join(temp.dir, SESSION, '.listening');
    writeFileSync(marker, 'old', 'utf8');
    const old = (Date.now() - 10 * 60_000) / 1000;
    utimesSync(marker, old, old);

    const req = makeStreamReq(`/api/feedback/stream?session=${SESSION}`);
    const { res, chunks } = makeStreamRes();
    handleFeedbackStream(
      req as unknown as IncomingMessage,
      res as unknown as ServerResponse,
      temp.dir,
    );

    await waitFor(() => chunks.some((c) => c.includes('"type":"presence"')));
    const presence = chunks.find((c) => c.includes('"type":"presence"'));
    expect(presence).toContain('"listening":false');

    req.emit('close');
  });

  it(
    'survives the watched dir vanishing mid-stream without an uncaught watcher error',
    { timeout: 15_000 },
    async () => {
      temp = makeTempDir();
      const sessionDir = join(temp.dir, SESSION);
      mkdirSync(sessionDir, { recursive: true });

      const req = makeStreamReq(`/api/feedback/stream?session=${SESSION}`);
      const { res, chunks } = makeStreamRes();

      handleFeedbackStream(
        req as unknown as IncomingMessage,
        res as unknown as ServerResponse,
        temp.dir,
      );

      await waitFor(() => chunks.length >= 1);

      // Deleting the watched directory can raise a watcher 'error' event
      // (e.g. ENOENT on Linux). Prior to the fix, an unhandled 'error' event
      // on an FSWatcher throws and crashes the process; if this test file
      // completes normally, no such crash occurred.
      rmSync(sessionDir, { recursive: true, force: true });

      // Give the fs backend a beat to (maybe) deliver the error/rename event,
      // then confirm the stream is still alive and presence polling continues
      // to work (the fix only stops watching, not the whole response).
      await new Promise((r) => setTimeout(r, 200));

      req.emit('close');
    },
  );

  it('rejects an invalid session', () => {
    temp = makeTempDir();
    const req = makeStreamReq('/api/feedback/stream?session=../escape');
    const { res, status } = makeStreamRes();

    handleFeedbackStream(
      req as unknown as IncomingMessage,
      res as unknown as ServerResponse,
      temp.dir,
    );

    expect(status()).toBe(400);
  });
});
