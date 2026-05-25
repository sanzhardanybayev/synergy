import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { lineColToOffset } from './anchor.js';
import { readJsonBody, sendJson } from './http.js';
import { resolveSessionsRelative } from './paths.js';

type StatusKind = 'phase-frontmatter' | 'inline-status';

interface PhaseFrontmatterRequest {
  kind: 'phase-frontmatter';
  file: string;
  newStatus: string;
}

interface InlineStatusRequest {
  kind: 'inline-status';
  file: string;
  sourceStart: { line: number; col: number };
  sourceEnd: { line: number; col: number };
  expectedText: string;
  newStatus: string;
}

type StatusRequest = PhaseFrontmatterRequest | InlineStatusRequest;

const VALID_STATUSES = new Set(['draft', 'proposed', 'in-progress', 'blocked', 'done', 'shipped']);

function isStatusRequest(v: unknown): v is StatusRequest {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  const kind = r.kind as StatusKind | undefined;
  if (typeof r.file !== 'string' || typeof r.newStatus !== 'string') return false;
  if (kind === 'phase-frontmatter') return true;
  if (kind === 'inline-status') {
    return (
      typeof r.expectedText === 'string' &&
      typeof r.sourceStart === 'object' &&
      r.sourceStart !== null &&
      typeof (r.sourceStart as Record<string, unknown>).line === 'number' &&
      typeof (r.sourceStart as Record<string, unknown>).col === 'number' &&
      typeof r.sourceEnd === 'object' &&
      r.sourceEnd !== null &&
      typeof (r.sourceEnd as Record<string, unknown>).line === 'number' &&
      typeof (r.sourceEnd as Record<string, unknown>).col === 'number'
    );
  }
  return false;
}

/**
 * Rewrite a `status: <value>` line in a YAML frontmatter block.
 *
 * Preserves all other keys and the existing quoting style of the value.
 * If `status:` is absent, it is inserted after `title:` if present, otherwise
 * appended as the last key before the closing `---`.
 */
function rewriteFrontmatterStatus(source: string, newStatus: string): string {
  if (!source.startsWith('---')) {
    throw new Error('rewriteFrontmatterStatus: no frontmatter found (does not start with ---)');
  }
  const closingIdx = source.indexOf('\n---', 3);
  if (closingIdx === -1) {
    throw new Error('rewriteFrontmatterStatus: unterminated frontmatter block');
  }
  const afterOpenDashes = source.indexOf('\n', 0) + 1;
  const frontmatter = source.slice(afterOpenDashes, closingIdx);

  const STATUS_KEY_RE = /^(status\s*:\s*)(.*)$/m;
  const match = STATUS_KEY_RE.exec(frontmatter);

  if (match) {
    const newFrontmatter =
      frontmatter.slice(0, match.index) +
      match[1] +
      newStatus +
      frontmatter.slice(match.index + match[0].length);
    return source.slice(0, afterOpenDashes) + newFrontmatter + source.slice(closingIdx);
  }

  const TITLE_KEY_RE = /^(title\s*:.*)$/m;
  const titleMatch = TITLE_KEY_RE.exec(frontmatter);
  if (titleMatch) {
    const insertAt = titleMatch.index + titleMatch[0].length;
    const newFrontmatter = `${frontmatter.slice(0, insertAt)}\nstatus: ${newStatus}${frontmatter.slice(insertAt)}`;
    return source.slice(0, afterOpenDashes) + newFrontmatter + source.slice(closingIdx);
  }

  const newFrontmatter = `${frontmatter}\nstatus: ${newStatus}`;
  return source.slice(0, afterOpenDashes) + newFrontmatter + source.slice(closingIdx);
}

/**
 * Rewrite the `value` attribute inside a `<Status value="..." />` element.
 * Leaves other attributes (e.g. `note="..."`) untouched.
 * Throws if the value attribute cannot be located.
 */
function rewriteInlineStatusText(elementText: string, newStatus: string): string {
  const VALUE_ATTR_RE = /(<Status\s[^>]*value=")([^"]*?)(")/;
  const match = VALUE_ATTR_RE.exec(elementText);
  if (!match) {
    throw new Error(`rewriteInlineStatusText: could not locate value attribute in: ${elementText}`);
  }
  return (
    elementText.slice(0, match.index) +
    match[1] +
    newStatus +
    match[3] +
    elementText.slice(match.index + match[0].length)
  );
}

function atomicWrite(absPath: string, content: string): void {
  const tmpPath = join(dirname(absPath), `.${Date.now()}.tmp`);
  try {
    writeFileSync(tmpPath, content, 'utf8');
    renameSync(tmpPath, absPath);
  } catch (err) {
    try {
      if (existsSync(tmpPath)) renameSync(tmpPath, `${tmpPath}.dead`);
    } catch {
      /* ignore cleanup error */
    }
    throw err;
  }
}

export async function handleStatus(
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

  if (!isStatusRequest(body)) {
    sendJson(res, 400, { error: 'bad_request', detail: 'missing or invalid required fields' });
    return;
  }

  // Validate against the closed status set so a stray value (e.g. one containing
  // a newline) can never corrupt the YAML frontmatter or the inline prop.
  if (!VALID_STATUSES.has(body.newStatus)) {
    sendJson(res, 400, {
      error: 'bad_status',
      detail: `invalid status value: ${JSON.stringify(body.newStatus)}`,
    });
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

  if (body.kind === 'phase-frontmatter') {
    let newSource: string;
    try {
      newSource = rewriteFrontmatterStatus(source, body.newStatus);
    } catch (err) {
      sendJson(res, 400, { error: 'frontmatter_parse_error', detail: String(err) });
      return;
    }
    try {
      atomicWrite(absPath, newSource);
    } catch (err) {
      sendJson(res, 500, { error: 'write_failed', detail: String(err) });
      return;
    }
    sendJson(res, 200, { ok: true });
    return;
  }

  // kind === 'inline-status'
  let startOffset: number;
  let endOffset: number;
  try {
    startOffset = lineColToOffset(source, body.sourceStart.line, body.sourceStart.col);
    endOffset = lineColToOffset(source, body.sourceEnd.line, body.sourceEnd.col);
  } catch (err) {
    sendJson(res, 400, { error: 'bad_range', detail: String(err) });
    return;
  }

  const currentText = source.slice(startOffset, endOffset);
  if (currentText !== body.expectedText) {
    sendJson(res, 409, { error: 'stale_range', currentText });
    return;
  }

  let newElementText: string;
  try {
    newElementText = rewriteInlineStatusText(currentText, body.newStatus);
  } catch (err) {
    sendJson(res, 400, { error: 'inline_status_parse_error', detail: String(err) });
    return;
  }

  const newSource = source.slice(0, startOffset) + newElementText + source.slice(endOffset);
  try {
    atomicWrite(absPath, newSource);
  } catch (err) {
    sendJson(res, 500, { error: 'write_failed', detail: String(err) });
    return;
  }
  sendJson(res, 200, { ok: true });
}

export { rewriteFrontmatterStatus, rewriteInlineStatusText };
