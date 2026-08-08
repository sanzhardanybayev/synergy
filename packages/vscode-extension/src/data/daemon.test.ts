import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ReviewRef } from '@synergy/review-core';
import { afterEach, describe, expect, it } from 'vitest';
import { tryConnectDaemon } from './daemon.js';

const roots: string[] = [];
function createRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'synergy-vscode-daemon-'));
  roots.push(root);
  return root;
}
afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

const reference: ReviewRef = { workspaceId: 'ws-1', revisionId: 'rev-1' };

function writeRuntimeFile(root: string, port: number): void {
  mkdirSync(join(root, '.synergy'), { recursive: true });
  writeFileSync(
    join(root, '.synergy', 'preview.runtime.json'),
    JSON.stringify({
      schemaVersion: 1,
      protocolVersion: 1,
      state: 'ready',
      instanceId: 'instance-1',
      projectId: 'sha256:deadbeef',
      pid: process.pid,
      host: '127.0.0.1',
      port,
      origin: `http://127.0.0.1:${port}`,
      preferredPort: port,
      strictPort: false,
      startedAt: new Date().toISOString(),
      controlToken: 'a'.repeat(64),
      toolVersion: '0.0.0-test',
    }),
  );
}

function sseServer(
  onRequest: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve) => {
    const server = http.createServer(onRequest);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ server, port });
    });
  });
}

function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = (): void => {
      if (condition()) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error('waitFor timed out'));
        return;
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}

describe('tryConnectDaemon', () => {
  it('fires onEvent when the daemon streams SSE events', async () => {
    const root = createRoot();
    let sendEvent: (() => void) | undefined;
    const { server, port } = await sseServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      sendEvent = () => {
        res.write('id: state:1\nevent: progress\ndata: {}\n\n');
      };
    });
    writeRuntimeFile(root, port);

    let eventCount = 0;
    const link = tryConnectDaemon(root, reference, () => {
      eventCount += 1;
    });

    await waitFor(() => sendEvent !== undefined);
    sendEvent?.();

    await waitFor(() => eventCount === 1);
    expect(eventCount).toBe(1);

    link.dispose();
    server.close();
  });

  it('ignores keepalive comment frames', async () => {
    const root = createRoot();
    let sendKeepalive: (() => void) | undefined;
    let sendReal: (() => void) | undefined;
    const { server, port } = await sseServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      sendKeepalive = () => res.write(': keepalive\n\n');
      sendReal = () => res.write('id: state:1\nevent: progress\ndata: {}\n\n');
    });
    writeRuntimeFile(root, port);

    let eventCount = 0;
    const link = tryConnectDaemon(root, reference, () => {
      eventCount += 1;
    });

    await waitFor(() => sendKeepalive !== undefined);
    sendKeepalive?.();
    sendKeepalive?.();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(eventCount).toBe(0);

    sendReal?.();
    await waitFor(() => eventCount === 1);

    link.dispose();
    server.close();
  });

  it('resolves to a silent no-op link when no daemon is running', async () => {
    const root = createRoot();
    writeRuntimeFile(root, 39_999); // nothing listens on this port

    let eventCount = 0;
    const link = tryConnectDaemon(root, reference, () => {
      eventCount += 1;
    });

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(eventCount).toBe(0);
    expect(() => link.dispose()).not.toThrow();
  });

  it('is a no-op without throwing when the runtime file is absent', () => {
    const root = createRoot();
    expect(() => {
      const link = tryConnectDaemon(root, reference, () => {});
      link.dispose();
    }).not.toThrow();
  });

  it('falls back to the default port when the runtime file is invalid', async () => {
    const root = createRoot();
    mkdirSync(join(root, '.synergy'), { recursive: true });
    writeFileSync(join(root, '.synergy', 'preview.runtime.json'), 'not json');

    expect(() => {
      const link = tryConnectDaemon(root, reference, () => {});
      link.dispose();
    }).not.toThrow();
  });

  it('dispose closes the socket before the connection settles, without an error escaping', async () => {
    const root = createRoot();
    const { server, port } = await sseServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    });
    writeRuntimeFile(root, port);

    const link = tryConnectDaemon(root, reference, () => {});
    link.dispose();
    await new Promise((resolve) => setTimeout(resolve, 100));

    server.close();
  });

  it('resolves the origin from the runtime file rather than the hardcoded default port', async () => {
    const root = createRoot();
    let requestedPath: string | undefined;
    const { server, port } = await sseServer((req, res) => {
      requestedPath = req.url;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('id: state:1\nevent: progress\ndata: {}\n\n');
    });
    writeRuntimeFile(root, port);

    let eventCount = 0;
    const link = tryConnectDaemon(root, reference, () => {
      eventCount += 1;
    });

    await waitFor(() => eventCount === 1);
    expect(requestedPath).toBe(
      `/api/reviews/${reference.workspaceId}/${reference.revisionId}/stream`,
    );

    link.dispose();
    server.close();
  });
});
