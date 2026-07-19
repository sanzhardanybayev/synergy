import { previewStatus } from './preview.js';

/** True when runtime metadata and the identified preview daemon agree. */
export async function daemonRunning(root?: string): Promise<boolean> {
  return (await previewStatus(root)).running;
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
  const status = await previewStatus(root);
  if (!status.running || status.origin === null) return null;
  const url = `${status.origin}${path}`;
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
