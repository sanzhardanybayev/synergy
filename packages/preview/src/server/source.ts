import { existsSync, readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson } from './http.js';
import { resolveSessionsRelative } from './paths.js';

/**
 * GET /api/source?file=<sessionsDir-relative-path>
 *
 * Returns the raw text of an MDX file under sessionsDir. Used by the comment
 * layer, which needs the original source (not the compiled module) to compute
 * and re-anchor selection coordinates.
 *
 * The `file` path is resolved relative to sessionsDir and asserted to stay
 * inside it (traversal → 400). Missing file → 404.
 */
export function handleSource(req: IncomingMessage, res: ServerResponse, sessionsDir: string): void {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const fileParam = url.searchParams.get('file');

  if (!fileParam) {
    sendJson(res, 400, { error: 'bad_request', detail: 'file parameter is required' });
    return;
  }

  let absPath: string;
  try {
    absPath = resolveSessionsRelative(sessionsDir, fileParam);
  } catch (err) {
    sendJson(res, 400, { error: 'bad_path', detail: String(err) });
    return;
  }

  if (!existsSync(absPath)) {
    sendJson(res, 404, { error: 'not_found' });
    return;
  }

  let source: string;
  try {
    source = readFileSync(absPath, 'utf8');
  } catch (err) {
    sendJson(res, 500, { error: 'read_failed', detail: String(err) });
    return;
  }

  sendJson(res, 200, { file: fileParam, source });
}
