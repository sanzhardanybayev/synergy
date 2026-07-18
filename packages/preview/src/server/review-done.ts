import { mkdirSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { REVIEW_DONE_FILE } from '@synergy/state';
import { readJsonBody, sendJson } from './http.js';

// Re-exported for existing importers of this module; the authoritative
// definition (and doc comment) now lives in @synergy/state's
// feedback-files.ts, shared with @synergy/cli's feedback-wait.
export { REVIEW_DONE_FILE };

/**
 * POST /api/review-done — signal the end of the user's review round.
 */
export async function handleReviewDone(
  req: IncomingMessage,
  res: ServerResponse,
  feedbackDir: string,
): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: 'invalid_json' });
    return;
  }

  const session = (body as Record<string, unknown> | null)?.session;
  if (typeof session !== 'string' || session.length === 0) {
    sendJson(res, 400, { error: 'bad_request', detail: 'session is required' });
    return;
  }
  if (
    session.includes('..') ||
    session.includes('/') ||
    session.includes('\\') ||
    session.includes('\0')
  ) {
    sendJson(res, 400, { error: 'bad_session', detail: 'session must be a single name segment' });
    return;
  }

  const sessionDir = join(feedbackDir, session);
  try {
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, REVIEW_DONE_FILE), `${new Date().toISOString()}\n`, 'utf8');
  } catch (err) {
    sendJson(res, 500, { error: 'write_failed', detail: String(err) });
    return;
  }

  sendJson(res, 200, { ok: true });
}
