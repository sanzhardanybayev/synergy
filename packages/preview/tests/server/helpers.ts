/**
 * Lightweight mock helpers for testing Node.js HTTP handlers without starting
 * a real server. These construct minimal IncomingMessage / ServerResponse
 * stand-ins that capture status + body and expose them synchronously after
 * the handler resolves.
 *
 * The mock implementations satisfy only the properties our handlers actually
 * use. The types are cast with `as unknown as T` at the call site (not here)
 * so this file stays clean.
 */

import { EventEmitter } from 'node:events';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// ---------------------------------------------------------------------------
// Temp-dir factory (mirrors buildIndex.test.ts pattern)
// ---------------------------------------------------------------------------

export function makeTempDir(files: Record<string, string> = {}): {
  dir: string;
  cleanup: () => void;
} {
  const dir = join(
    tmpdir(),
    `synergy-server-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf8');
  }
  return {
    dir,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Mock IncomingMessage
// ---------------------------------------------------------------------------

export interface MockRequest extends EventEmitter {
  method: string;
  url: string;
  headers: Record<string, string | undefined>;
  _body: string;
  resume(): void;
}

export function makeMockReq(options: {
  method?: string;
  url?: string;
  body?: unknown;
  rawBody?: string;
  emitError?: boolean;
  headers?: Record<string, string | undefined>;
}): MockRequest {
  const emitter = new EventEmitter() as MockRequest;
  emitter.method = options.method ?? 'GET';
  emitter.url = options.url ?? '/';
  emitter.headers =
    options.headers ?? (options.body === undefined ? {} : { 'content-type': 'application/json' });
  emitter._body =
    options.rawBody ?? (options.body !== undefined ? JSON.stringify(options.body) : '');
  emitter.resume = () => undefined;

  // Emit data/end asynchronously so handlers can attach listeners first.
  setImmediate(() => {
    if (options.emitError) {
      emitter.emit('error', new Error('injected request stream failure'));
      return;
    }
    if (emitter._body.length > 0) {
      emitter.emit('data', Buffer.from(emitter._body, 'utf8'));
    }
    emitter.emit('end');
  });

  return emitter;
}

// ---------------------------------------------------------------------------
// Mock ServerResponse
// ---------------------------------------------------------------------------

export interface MockResponse {
  statusCode: number;
  headers: Record<string, string | number>;
  body: string;
  /** Parsed response body (populated after the handler writes). */
  json: unknown;
}

export function makeMockRes(): {
  res: unknown;
  result: () => MockResponse;
} {
  const captured: MockResponse = {
    statusCode: 0,
    headers: {},
    body: '',
    json: undefined,
  };

  const res = Object.assign(new EventEmitter(), {
    writeHead(status: number, headers: Record<string, string | number>) {
      captured.statusCode = status;
      captured.headers = headers ?? {};
    },
    end(payload: string | Buffer) {
      captured.body = typeof payload === 'string' ? payload : payload.toString('utf8');
      try {
        captured.json = JSON.parse(captured.body);
      } catch {
        captured.json = undefined;
      }
    },
  });

  return { res, result: () => captured };
}
