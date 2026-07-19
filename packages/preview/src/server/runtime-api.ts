import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Connect } from 'vite';
import { readJsonBody } from './http.js';

export interface PreviewHealth {
  protocolVersion: 1;
  state: 'ready';
  instanceId: string;
  projectId: string;
  pid: number;
  port: number;
}

export interface RuntimeApiOptions {
  health: PreviewHealth;
  controlToken: string;
  shutdown(instanceId: string): Promise<void>;
}

function sendRuntimeJson(res: ServerResponse, statusCode: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.statusCode = statusCode;
  res.setHeader('content-type', 'application/json');
  res.setHeader('content-length', Buffer.byteLength(payload));
  res.end(payload);
}

function isLoopbackAddress(remoteAddress: string | undefined): boolean {
  if (remoteAddress === undefined) return true;
  return (
    remoteAddress === '127.0.0.1' || remoteAddress === '::1' || remoteAddress === '::ffff:127.0.0.1'
  );
}

function readBearerToken(req: IncomingMessage): string | null {
  const authorization = req.headers.authorization;
  if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) return null;
  return authorization.slice('Bearer '.length);
}

function tokensMatch(actual: string | null, expected: string): boolean {
  if (actual === null) return false;
  const actualBuffer = Buffer.from(actual, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  return (
    actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

function scheduleShutdown(
  res: ServerResponse,
  shutdown: RuntimeApiOptions['shutdown'],
  instanceId: string,
): void {
  res.once('finish', () => {
    setImmediate(() => {
      void shutdown(instanceId).catch((error: unknown) => {
        console.error('Synergy preview shutdown failed:', error);
      });
    });
  });
}

async function handleShutdown(
  req: IncomingMessage,
  res: ServerResponse,
  options: RuntimeApiOptions,
): Promise<void> {
  if (!tokensMatch(readBearerToken(req), options.controlToken)) {
    sendRuntimeJson(res, 401, { error: 'unauthorized' });
    return;
  }

  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch {
    sendRuntimeJson(res, 400, { error: 'invalid_request' });
    return;
  }

  if (
    typeof body !== 'object' ||
    body === null ||
    !('instanceId' in body) ||
    typeof body.instanceId !== 'string'
  ) {
    sendRuntimeJson(res, 400, { error: 'invalid_request' });
    return;
  }

  if (body.instanceId !== options.health.instanceId) {
    sendRuntimeJson(res, 409, { error: 'instance_mismatch' });
    return;
  }

  scheduleShutdown(res, options.shutdown, body.instanceId);
  sendRuntimeJson(res, 202, { ok: true });
}

export function runtimeApiMiddleware(options: RuntimeApiOptions): Connect.NextHandleFunction {
  return (req, res, next) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    const isHealthRoute = pathname === '/api/runtime/health';
    const isShutdownRoute = pathname === '/api/runtime/shutdown';
    if (!isHealthRoute && !isShutdownRoute) {
      next();
      return;
    }

    if (!isLoopbackAddress(req.socket?.remoteAddress)) {
      sendRuntimeJson(res, 403, { error: 'loopback_only' });
      return;
    }

    if (isHealthRoute) {
      if (req.method !== 'GET') {
        sendRuntimeJson(res, 405, { error: 'method_not_allowed' });
        return;
      }
      sendRuntimeJson(res, 200, options.health);
      return;
    }

    if (req.method !== 'POST') {
      sendRuntimeJson(res, 405, { error: 'method_not_allowed' });
      return;
    }
    void handleShutdown(req, res, options);
  };
}
