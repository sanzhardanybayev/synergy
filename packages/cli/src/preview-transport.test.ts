import { describe, expect, it, vi } from 'vitest';
import { requestPreviewHealth, requestPreviewShutdown } from './preview-transport.js';

const HEALTH = {
  protocolVersion: 1,
  state: 'ready',
  instanceId: 'instance-1',
  projectId: 'sha256:project',
  pid: 12_345,
  port: 4321,
} as const;

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe('preview health transport', () => {
  it('distinguishes HTTP, malformed, and unknown transport failures from absence', async () => {
    await expect(
      requestPreviewHealth('http://127.0.0.1:4321', 100, {
        fetch: async () => response({}, 503),
      }),
    ).resolves.toEqual({ kind: 'http-error', status: 503 });
    await expect(
      requestPreviewHealth('http://127.0.0.1:4321', 100, {
        fetch: async () => response({}),
      }),
    ).resolves.toEqual({ kind: 'malformed' });
    await expect(
      requestPreviewHealth('http://127.0.0.1:4321', 100, {
        fetch: async () => {
          throw new Error('socket failed');
        },
      }),
    ).resolves.toMatchObject({ kind: 'transport-error' });
  });

  it('reports only a definite loopback refusal as absent', async () => {
    const refused = new TypeError('fetch failed', {
      cause: Object.assign(new Error('connect refused'), { code: 'ECONNREFUSED' }),
    });

    await expect(
      requestPreviewHealth('http://127.0.0.1:4321', 100, {
        fetch: async () => {
          throw refused;
        },
      }),
    ).resolves.toEqual({ kind: 'absent' });
  });

  it('bounds a fetch adapter that ignores abort signals', async () => {
    const fetch = vi.fn(() => new Promise<Response>(() => undefined));
    const startedAt = performance.now();

    await expect(requestPreviewHealth('http://127.0.0.1:4321', 20, { fetch })).resolves.toEqual({
      kind: 'timeout',
    });

    expect(performance.now() - startedAt).toBeLessThan(100);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('bounds a health response whose JSON body never settles', async () => {
    const signals: AbortSignal[] = [];
    const cancel = vi.fn().mockResolvedValue(undefined);
    const response = new Response(
      new ReadableStream({
        cancel: () => cancel(),
      }),
    );
    Object.defineProperty(response, 'json', {
      value: () => new Promise<unknown>(() => undefined),
    });
    const startedAt = performance.now();

    await expect(
      requestPreviewHealth('http://127.0.0.1:4321', 20, {
        fetch: async (_input, init) => {
          if (init?.signal) signals.push(init.signal);
          return response;
        },
      }),
    ).resolves.toEqual({ kind: 'timeout' });

    expect(performance.now() - startedAt).toBeLessThan(100);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(true);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('aborts and cancels non-2xx health and shutdown response bodies', async () => {
    const signals: AbortSignal[] = [];
    const cancel = vi.fn().mockResolvedValue(undefined);
    const fetch = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      if (init?.signal) signals.push(init.signal);
      return new Response(
        new ReadableStream({
          cancel: () => cancel(),
        }),
        { status: 503 },
      );
    });

    await expect(requestPreviewHealth('http://127.0.0.1:4321', 100, { fetch })).resolves.toEqual({
      kind: 'http-error',
      status: 503,
    });
    await expect(
      requestPreviewShutdown('http://127.0.0.1:4321', 'instance-1', 'token', 100, { fetch }),
    ).resolves.toEqual({ kind: 'http-error', status: 503 });

    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(cancel).toHaveBeenCalledTimes(2);
  });

  it('aborts and cancels a body when the fetch consumes the complete deadline', async () => {
    const signals: AbortSignal[] = [];
    const cancel = vi.fn().mockResolvedValue(undefined);
    const response = new Response(
      new ReadableStream({
        cancel: () => cancel(),
      }),
    );
    let nowCalls = 0;

    await expect(
      requestPreviewHealth('http://127.0.0.1:4321', 100, {
        now: () => (nowCalls++ === 0 ? 0 : 100),
        fetch: async (_input, init) => {
          if (init?.signal) signals.push(init.signal);
          return response;
        },
      }),
    ).resolves.toEqual({ kind: 'timeout' });

    expect(signals[0]?.aborted).toBe(true);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('returns a fully validated healthy response', async () => {
    await expect(
      requestPreviewHealth('http://127.0.0.1:4321', 100, {
        fetch: async () => response(HEALTH),
      }),
    ).resolves.toEqual({ kind: 'healthy', health: HEALTH });
  });
});
