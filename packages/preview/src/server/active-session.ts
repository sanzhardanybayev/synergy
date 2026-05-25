import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { readJsonBody, sendJson } from './http.js';

interface ActiveSessionRequest {
  session: string;
}

function isActiveSessionRequest(v: unknown): v is ActiveSessionRequest {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return typeof r.session === 'string' && r.session.length > 0;
}

/**
 * Atomically write `<synergyDir>/active-session` as JSON.
 * Mirrors the atomicWrite pattern from edit.ts / feedback.ts.
 */
function atomicWriteJson(absPath: string, data: unknown): void {
  const tmpPath = join(dirname(absPath), `.${Date.now()}.tmp`);
  const content = JSON.stringify(data, null, 2);
  try {
    writeFileSync(tmpPath, content, 'utf8');
    renameSync(tmpPath, absPath);
  } catch (err) {
    try {
      renameSync(tmpPath, `${tmpPath}.dead`);
    } catch {
      /* ignore cleanup error */
    }
    throw err;
  }
}

/**
 * POST /api/active-session
 *
 * Body: `{ session: string }`
 * Validates that `session` is a single path segment (no `..` or `/`).
 * Writes `<synergyDir>/active-session` atomically as:
 *   `{ session, lastSeen: <ISO> }`
 *
 * @param req        - Incoming HTTP request.
 * @param res        - Server response.
 * @param synergyDir - Absolute path to the `.synergy/` directory.
 */
export async function handleActiveSession(
  req: IncomingMessage,
  res: ServerResponse,
  synergyDir: string,
): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: 'invalid_json' });
    return;
  }

  if (!isActiveSessionRequest(body)) {
    sendJson(res, 400, { error: 'bad_request', detail: 'session field is required' });
    return;
  }

  // Reject paths that would escape a single name segment.
  if (body.session.includes('/') || body.session.includes('..') || body.session.includes('\0')) {
    sendJson(res, 400, {
      error: 'bad_session',
      detail: 'session must be a single path segment with no slashes or traversal sequences',
    });
    return;
  }

  mkdirSync(synergyDir, { recursive: true });

  const absPath = join(synergyDir, 'active-session');
  const lastSeen = new Date().toISOString();
  try {
    atomicWriteJson(absPath, { session: body.session, lastSeen });
  } catch (err) {
    sendJson(res, 500, { error: 'write_failed', detail: String(err) });
    return;
  }

  sendJson(res, 200, { ok: true });
}
