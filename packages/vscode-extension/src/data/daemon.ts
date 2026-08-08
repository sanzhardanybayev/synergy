import { readFileSync } from 'node:fs';
import * as http from 'node:http';
import { join } from 'node:path';
import type { ReviewRef } from '@synergy/review-core';

/**
 * Optional live-refresh upgrade: when the Synergy preview daemon is running, this subscribes to
 * its SSE review stream so the panel refreshes the instant the daemon observes a change, instead
 * of waiting on the fs watcher's own debounce. The fs watcher (src/panel/ReviewViewProvider.ts)
 * remains authoritative - a daemon that never connects, or that drops mid-session, changes
 * nothing about correctness, only latency.
 */
export interface DaemonLink {
  dispose(): void;
}

const DEFAULT_ORIGIN = 'http://127.0.0.1:4321';
const CONNECT_TIMEOUT_MS = 2000;

/**
 * Resolves the preview daemon's verified origin the same way the CLI/skills do: read
 * `<projectRoot>/.synergy/preview.runtime.json`, which the running preview server writes with
 * the port it actually bound (ports are no longer pinned to 4321 - the preview picks whatever
 * port is reachable and records the verified origin there; see packages/cli/src/preview.ts and
 * packages/cli/src/preview-runtime.ts). We deliberately re-implement a small, permissive
 * validation here instead of importing @synergy/cli's `readPreviewRuntime`: that package pulls
 * in the full CLI dependency graph (vite, cac, ...) purely for this one helper, which is not
 * worth bundling into the extension. We only need "does this look like a runtime file that
 * names a real port", not the CLI's full health-check verification - `tryConnectDaemon` below
 * treats a failed connection as silent no-op regardless, so a stale/wrong runtime file degrades
 * to the same no-op path as no daemon at all.
 *
 * Falls back to the historical fixed port (4321) only when the runtime file is missing, absent,
 * or unusable.
 */
function resolveDaemonOrigin(projectRoot: string): string {
  const runtimeFilePath = join(projectRoot, '.synergy', 'preview.runtime.json');
  try {
    const raw = readFileSync(runtimeFilePath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return DEFAULT_ORIGIN;
    const record = parsed as Record<string, unknown>;
    const { port, origin, state } = record;
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65_535) {
      return DEFAULT_ORIGIN;
    }
    if (state !== undefined && state !== 'ready') return DEFAULT_ORIGIN;
    const expectedOrigin = `http://127.0.0.1:${port}`;
    if (origin !== undefined && origin !== expectedOrigin) return DEFAULT_ORIGIN;
    return expectedOrigin;
  } catch {
    return DEFAULT_ORIGIN;
  }
}

/** True for a complete SSE frame that carries a named event, false for bare comments/keepalives. */
function isNamedEventFrame(frame: string): boolean {
  return frame.split('\n').some((line) => line.startsWith('event:'));
}

/**
 * Connects to the preview daemon's per-revision SSE stream, if one is reachable, and calls
 * `onEvent` for every named event frame it receives (keepalive comments are ignored). Deviates
 * from the brief's `tryConnectDaemon(reference, onEvent)` signature by taking `projectRoot` as
 * the first argument - resolving the daemon's verified origin requires reading that project's
 * `.synergy/preview.runtime.json`, and the caller (ReviewViewProvider) already has the root
 * on hand per open session.
 *
 * All failure modes - no runtime file, no daemon listening, connection refused, non-200
 * response, mid-stream drop - are silent: `onEvent` simply never fires again and nothing is
 * thrown or logged. There is no retry loop; a fresh `tryConnectDaemon` call on the next
 * `openSession` is the only reconnect path, so a downed daemon cannot cause a retry storm.
 */
export function tryConnectDaemon(
  projectRoot: string,
  reference: ReviewRef,
  onEvent: () => void,
): DaemonLink {
  let disposed = false;
  let request: http.ClientRequest | undefined;

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    request?.destroy();
  };

  try {
    const origin = resolveDaemonOrigin(projectRoot);
    const url = new URL(
      `/api/reviews/${encodeURIComponent(reference.workspaceId)}/${encodeURIComponent(reference.revisionId)}/stream`,
      origin,
    );

    request = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        headers: { Accept: 'text/event-stream' },
      },
      (response) => {
        if (disposed) {
          response.destroy();
          return;
        }
        if (response.statusCode !== 200) {
          response.destroy();
          request?.destroy();
          return;
        }
        // The daemon responded, so this is a genuine long-lived stream, not a stalled connect
        // attempt - disable the connect-phase timeout so keepalive gaps never trip it.
        request?.setTimeout(0);

        response.setEncoding('utf8');
        let buffer = '';
        response.on('data', (chunk: string) => {
          if (disposed) return;
          buffer += chunk;
          const frames = buffer.split('\n\n');
          buffer = frames.pop() ?? '';
          for (const frame of frames) {
            if (isNamedEventFrame(frame)) onEvent();
          }
        });
        // Silence stream-level errors/close: they just mean the daemon went away, which is the
        // fs watcher's job to notice from here on.
        response.on('error', () => {});
        response.on('close', () => {});
      },
    );

    request.setTimeout(CONNECT_TIMEOUT_MS, () => request?.destroy());
    // Any transport error (ECONNREFUSED, reset, etc.) means the daemon is down; stay silent.
    request.on('error', () => {});
    request.end();
  } catch {
    // Malformed runtime file, unparsable URL, etc. - treat exactly like daemon-down.
  }

  return { dispose };
}
