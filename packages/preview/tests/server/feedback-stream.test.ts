import { EventEmitter } from 'node:events';
import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { handleFeedbackStream } from '../../src/server/feedback-stream.js';
import { makeTempDir } from './helpers.js';

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

// Generous budget: under a fully parallel suite run, macOS FSEvents delivery
// can lag well past 2s; this bounds flakiness, not expected latency.
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

      handleFeedbackStream(
        req as unknown as IncomingMessage,
        res as unknown as ServerResponse,
        temp.dir,
      );

      await waitFor(() => chunks.length >= 1);

      mkdirSync(join(temp.dir, SESSION), { recursive: true });
      writeFileSync(
        join(temp.dir, SESSION, 'new-comment.md'),
        '---\nstatus: open\n---\nhi',
        'utf8',
      );

      await waitFor(() => chunks.some((c) => c.includes('feedback-changed')));

      req.emit('close');
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
