import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import {
  type PreviewHealth,
  type RuntimeApiOptions,
  runtimeApiMiddleware,
} from '../../src/server/runtime-api.js';

const HEALTH: PreviewHealth = {
  protocolVersion: 1,
  state: 'ready',
  instanceId: 'instance-1',
  projectId: 'sha256:project-1',
  pid: 1234,
  port: 4322,
};

const CONTROL_TOKEN = '0123456789abcdef0123456789abcdef';

function makeOptions(shutdown = vi.fn<RuntimeApiOptions['shutdown']>()): RuntimeApiOptions {
  return { health: HEALTH, controlToken: CONTROL_TOKEN, shutdown };
}

interface MiddlewareResponse {
  statusCode: number;
  json: unknown;
}

async function callRuntimeApi(options: {
  runtime: RuntimeApiOptions;
  method: string;
  url: string;
  token?: string;
  instanceId?: string;
  remoteAddress?: string;
}): Promise<MiddlewareResponse> {
  const headers: Record<string, string> = {};
  if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`;
  const request = Object.assign(new EventEmitter(), {
    method: options.method,
    url: options.url,
    headers,
    socket: { remoteAddress: options.remoteAddress ?? '127.0.0.1' },
  });
  const responseEmitter = new EventEmitter();
  const response = Object.assign(responseEmitter, {
    statusCode: 0,
    headers: new Map<string, string | number>(),
    setHeader(name: string, value: string | number) {
      this.headers.set(name, value);
    },
    end(payload: string) {
      responseEmitter.emit('finish');
      responseEmitter.emit('test:end', payload);
    },
  });
  const result = new Promise<MiddlewareResponse>((resolve) => {
    response.once('test:end', (payload: string) => {
      resolve({ statusCode: response.statusCode, json: JSON.parse(payload) as unknown });
    });
  });

  runtimeApiMiddleware(options.runtime)(
    request as unknown as IncomingMessage,
    response as unknown as ServerResponse,
    vi.fn(),
  );
  if (options.method === 'POST') {
    request.emit(
      'data',
      Buffer.from(JSON.stringify({ instanceId: options.instanceId ?? HEALTH.instanceId })),
    );
    request.emit('end');
  }
  return result;
}

describe('runtimeApiMiddleware', () => {
  it('returns only the public health contract', async () => {
    const response = await callRuntimeApi({
      runtime: makeOptions(),
      method: 'GET',
      url: '/api/runtime/health',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json).toEqual(HEALTH);
    expect(JSON.stringify(HEALTH)).not.toContain('controlToken');
    expect(JSON.stringify(HEALTH)).not.toContain('projectRoot');
  });

  it.each([
    ['missing', undefined],
    ['incorrect', 'wrong-token'],
  ])('rejects a %s control token', async (_label, token) => {
    const shutdown = vi.fn<RuntimeApiOptions['shutdown']>();
    const response = await callRuntimeApi({
      runtime: makeOptions(shutdown),
      method: 'POST',
      url: '/api/runtime/shutdown',
      token,
    });

    expect(response.statusCode).toBe(401);
    expect(response.json).toEqual({ error: 'unauthorized' });
    expect(shutdown).not.toHaveBeenCalled();
  });

  it('rejects a shutdown request for another instance', async () => {
    const shutdown = vi.fn<RuntimeApiOptions['shutdown']>();
    const response = await callRuntimeApi({
      runtime: makeOptions(shutdown),
      method: 'POST',
      url: '/api/runtime/shutdown',
      token: CONTROL_TOKEN,
      instanceId: 'instance-2',
    });

    expect(response.statusCode).toBe(409);
    expect(response.json).toEqual({ error: 'instance_mismatch' });
    expect(shutdown).not.toHaveBeenCalled();
  });

  it('accepts matching token and instance and schedules shutdown after ending the response', async () => {
    const events: string[] = [];
    const shutdown = vi.fn(async () => {
      events.push('shutdown');
    });
    const middleware = runtimeApiMiddleware(makeOptions(shutdown));
    const request = Object.assign(new EventEmitter(), {
      method: 'POST',
      url: '/api/runtime/shutdown',
      headers: { authorization: `Bearer ${CONTROL_TOKEN}` },
      socket: { remoteAddress: '127.0.0.1' },
    });
    const responseEmitter = new EventEmitter();
    const response = Object.assign(responseEmitter, {
      statusCode: 0,
      setHeader: vi.fn(),
      end(payload: string) {
        events.push(`end:${payload}`);
        responseEmitter.emit('finish');
      },
    });

    middleware(
      request as unknown as IncomingMessage,
      response as unknown as ServerResponse,
      vi.fn(),
    );
    request.emit('data', Buffer.from(JSON.stringify({ instanceId: HEALTH.instanceId })));
    request.emit('end');
    await vi.waitFor(() => expect(shutdown).toHaveBeenCalledWith(HEALTH.instanceId));

    expect(response.statusCode).toBe(202);
    expect(events[0]).toBe('end:{"ok":true}');
    expect(events[1]).toBe('shutdown');
  });

  it.each(['/api/runtime/health', '/api/runtime/shutdown'])(
    'rejects non-loopback requests to %s when the peer address is present',
    (url) => {
      const middleware = runtimeApiMiddleware(makeOptions());
      const request = Object.assign(new EventEmitter(), {
        method: url.endsWith('shutdown') ? 'POST' : 'GET',
        url,
        headers: {},
        socket: { remoteAddress: '192.0.2.10' },
      });
      const responseEmitter = new EventEmitter();
      const response = Object.assign(responseEmitter, {
        statusCode: 0,
        body: '',
        setHeader: vi.fn(),
        end(payload: string) {
          this.body = payload;
        },
      });

      middleware(
        request as unknown as IncomingMessage,
        response as unknown as ServerResponse,
        vi.fn(),
      );

      expect(response.statusCode).toBe(403);
      expect(JSON.parse(response.body)).toEqual({ error: 'loopback_only' });
    },
  );
});
