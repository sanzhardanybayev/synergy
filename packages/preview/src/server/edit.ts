import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { lineColToOffset } from './anchor.js';
import { readJsonBody, sendJson } from './http.js';
import { resolveSessionsRelative } from './paths.js';

interface EditRequest {
  file: string;
  sourceStart: { line: number; col: number };
  sourceEnd: { line: number; col: number };
  expectedText: string;
  newText: string;
}

function isEditRequest(v: unknown): v is EditRequest {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.file === 'string' &&
    typeof r.sourceStart === 'object' &&
    r.sourceStart !== null &&
    typeof (r.sourceStart as Record<string, unknown>).line === 'number' &&
    typeof (r.sourceStart as Record<string, unknown>).col === 'number' &&
    typeof r.sourceEnd === 'object' &&
    r.sourceEnd !== null &&
    typeof (r.sourceEnd as Record<string, unknown>).line === 'number' &&
    typeof (r.sourceEnd as Record<string, unknown>).col === 'number' &&
    typeof r.expectedText === 'string' &&
    typeof r.newText === 'string'
  );
}

/**
 * Replace a span in an MDX file atomically.
 *
 * Coordinates follow unified/vfile conventions:
 *   - line: 1-indexed
 *   - col:  0-indexed byte offset from the start of the line
 *
 * Atomic write: content is written to `<file>.tmp` in the same directory,
 * then renamed over the original. This prevents HMR from ever seeing a
 * partial write.
 */
export async function handleEdit(
  req: IncomingMessage,
  res: ServerResponse,
  sessionsDir: string,
): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: 'invalid_json' });
    return;
  }

  if (!isEditRequest(body)) {
    sendJson(res, 400, { error: 'bad_request', detail: 'missing required fields' });
    return;
  }

  let absPath: string;
  try {
    absPath = resolveSessionsRelative(sessionsDir, body.file);
  } catch (err) {
    sendJson(res, 400, { error: 'bad_path', detail: String(err) });
    return;
  }

  if (!existsSync(absPath)) {
    sendJson(res, 404, { error: 'not_found' });
    return;
  }

  const source = readFileSync(absPath, 'utf8');

  let startOffset: number;
  let endOffset: number;
  try {
    startOffset = lineColToOffset(source, body.sourceStart.line, body.sourceStart.col);
    endOffset = lineColToOffset(source, body.sourceEnd.line, body.sourceEnd.col);
  } catch (err) {
    sendJson(res, 400, { error: 'bad_range', detail: String(err) });
    return;
  }

  if (startOffset > endOffset) {
    sendJson(res, 400, { error: 'bad_range', detail: 'sourceStart must precede sourceEnd' });
    return;
  }

  const currentText = source.slice(startOffset, endOffset);
  if (currentText !== body.expectedText) {
    sendJson(res, 409, { error: 'stale_range', currentText });
    return;
  }

  const newSource = source.slice(0, startOffset) + body.newText + source.slice(endOffset);
  const tmpPath = join(dirname(absPath), `.${Date.now()}.tmp`);
  try {
    writeFileSync(tmpPath, newSource, 'utf8');
    renameSync(tmpPath, absPath);
  } catch (err) {
    // Clean up tmp on failure — best-effort, ignore secondary errors.
    try {
      if (existsSync(tmpPath)) renameSync(tmpPath, `${tmpPath}.dead`);
    } catch {
      /* ignore cleanup error */
    }
    sendJson(res, 500, { error: 'write_failed', detail: String(err) });
    return;
  }

  sendJson(res, 200, { ok: true, newSize: newSource.length });
}
