import type { IncomingMessage, ServerResponse } from 'node:http';
import { type ValidationReport, validate } from '@synergy/validator';
import { sendJson } from './http.js';

/** Run validation against the consumer project root, optionally scoped to one session. */
export function runValidate(projectRoot: string, session?: string): ValidationReport {
  return validate({ projectRoot, session });
}

/** GET /api/validate?session=<name?> — returns the full ValidationReport JSON. */
export function handleValidate(
  req: IncomingMessage,
  res: ServerResponse,
  projectRoot: string,
): void {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const session = url.searchParams.get('session') ?? undefined;
  if (session && (session.includes('/') || session.includes('\\') || session.includes('..'))) {
    sendJson(res, 400, { error: 'bad_request', detail: `invalid session name: ${session}` });
    return;
  }
  try {
    sendJson(res, 200, runValidate(projectRoot, session));
  } catch (err) {
    sendJson(res, 500, {
      error: 'validate_failed',
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}
