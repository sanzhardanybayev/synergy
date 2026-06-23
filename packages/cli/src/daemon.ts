import { PREVIEW_PORT } from './paths.js';
import { previewStatus } from './preview.js';

/** True when a live preview daemon owns the PID file. */
export function daemonRunning(root?: string): boolean {
  return previewStatus(root, PREVIEW_PORT).running;
}

/**
 * Call the daemon if it is up. Returns parsed JSON on success, or `null` when the
 * daemon is down (so the caller runs the operation in-process instead).
 * Throws only when the daemon is up but returns a non-2xx response.
 */
export async function tryDaemon(
  root: string | undefined,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<unknown | null> {
  if (!daemonRunning(root)) return null;
  const url = `http://localhost:${PREVIEW_PORT}${path}`;
  let resp: Response;
  try {
    resp = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    // PID file said "alive" but the socket refused — fall back in-process.
    return null;
  }
  const text = await resp.text();
  const parsed = text ? JSON.parse(text) : {};
  if (!resp.ok) {
    const detail = (parsed as { detail?: string }).detail ?? `HTTP ${resp.status}`;
    throw new Error(detail);
  }
  return parsed;
}
