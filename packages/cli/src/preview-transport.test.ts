import { describe, expect, it, vi } from 'vitest';
import { requestPreviewHealth } from './preview-transport.js';

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
    const response = {
      ok: true,
      status: 200,
      json: () => new Promise<unknown>(() => undefined),
    } as Response;
    const startedAt = performance.now();

    await expect(
      requestPreviewHealth('http://127.0.0.1:4321', 20, {
        fetch: async () => response,
      }),
    ).resolves.toEqual({ kind: 'timeout' });

    expect(performance.now() - startedAt).toBeLessThan(100);
  });

  it('returns a fully validated healthy response', async () => {
    await expect(
      requestPreviewHealth('http://127.0.0.1:4321', 100, {
        fetch: async () => response(HEALTH),
      }),
    ).resolves.toEqual({ kind: 'healthy', health: HEALTH });
  });
});
