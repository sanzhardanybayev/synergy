import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { sep } from 'node:path';
import { resolve } from 'node:path';
import matter from 'gray-matter';
import { readJsonBody, sendJson } from './http.js';

// gray-matter is already a dep — using it for frontmatter parse/write.

interface Anchor {
  lineStart: number;
  colStart: number;
  lineEnd: number;
  colEnd: number;
  before: string;
  selected: string;
  after: string;
}

interface FeedbackPostRequest {
  session: string;
  file: string;
  anchor: Anchor;
  body: string;
}

interface FeedbackPatchRequest {
  status: 'resolved' | 'rejected';
  resolution?: string;
  rejection_reason?: string;
}

function isAnchor(v: unknown): v is Anchor {
  if (typeof v !== 'object' || v === null) return false;
  const a = v as Record<string, unknown>;
  return (
    typeof a.lineStart === 'number' &&
    typeof a.colStart === 'number' &&
    typeof a.lineEnd === 'number' &&
    typeof a.colEnd === 'number' &&
    typeof a.before === 'string' &&
    typeof a.selected === 'string' &&
    typeof a.after === 'string'
  );
}

function isFeedbackPostRequest(v: unknown): v is FeedbackPostRequest {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.session === 'string' &&
    r.session.length > 0 &&
    typeof r.file === 'string' &&
    r.file.length > 0 &&
    isAnchor(r.anchor) &&
    typeof r.body === 'string'
  );
}

function isFeedbackPatchRequest(v: unknown): v is FeedbackPatchRequest {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  const status = r.status;
  if (status === 'resolved') return true;
  if (status === 'rejected') return true;
  return false;
}

/**
 * Assert a feedback file path stays within feedbackDir. Throws on traversal.
 */
function resolveFeedbackPath(feedbackDir: string, session: string, filename: string): string {
  const resolved = resolve(feedbackDir, session, filename);
  const base = feedbackDir.endsWith(sep) ? feedbackDir : feedbackDir + sep;
  if (!resolved.startsWith(base)) {
    throw new Error(
      `Path traversal rejected: "${session}/${filename}" resolves outside feedbackDir`,
    );
  }
  return resolved;
}

/**
 * Generate a comment ID: ISO timestamp with colons replaced, plus 6 hex chars.
 * Example: `2026-05-25T093045-abc123`
 */
function generateCommentId(): string {
  const iso = new Date().toISOString().replace(/:/g, '').replace(/\..+$/, '');
  const hex = Math.floor(Math.random() * 0xffffff)
    .toString(16)
    .padStart(6, '0');
  return `${iso}-${hex}`;
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
      /* ignore */
    }
    throw err;
  }
}

/**
 * POST /api/feedback — write a new comment file.
 */
export async function handleFeedbackPost(
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

  if (!isFeedbackPostRequest(body)) {
    sendJson(res, 400, { error: 'bad_request', detail: 'missing required fields' });
    return;
  }

  // Reject traversal in session name or file.
  if (body.session.includes('..') || body.session.includes('/') || body.session.includes('\0')) {
    sendJson(res, 400, { error: 'bad_session', detail: 'session must be a single name segment' });
    return;
  }

  const id = generateCommentId();
  const filename = `${id}.md`;
  const sessionFeedbackDir = join(feedbackDir, body.session);

  let absPath: string;
  try {
    absPath = resolveFeedbackPath(feedbackDir, body.session, filename);
  } catch (err) {
    sendJson(res, 400, { error: 'bad_path', detail: String(err) });
    return;
  }

  mkdirSync(sessionFeedbackDir, { recursive: true });

  const created = new Date().toISOString();

  const frontmatter = [
    '---',
    `id: ${id}`,
    `session: ${body.session}`,
    `file: ${body.file}`,
    'status: open',
    `created: ${created}`,
    'anchor:',
    `  lineStart: ${body.anchor.lineStart}`,
    `  colStart: ${body.anchor.colStart}`,
    `  lineEnd: ${body.anchor.lineEnd}`,
    `  colEnd: ${body.anchor.colEnd}`,
    `  before: ${JSON.stringify(body.anchor.before)}`,
    `  selected: ${JSON.stringify(body.anchor.selected)}`,
    `  after: ${JSON.stringify(body.anchor.after)}`,
    '---',
    '',
    body.body,
  ].join('\n');

  try {
    atomicWrite(absPath, frontmatter);
  } catch (err) {
    sendJson(res, 500, { error: 'write_failed', detail: String(err) });
    return;
  }

  const relPath = `.synergy/feedback/${body.session}/${filename}`;
  sendJson(res, 200, { id, path: relPath });
}

/**
 * GET /api/feedback?session=<name> — list all comments for a session sorted by
 * `created` ascending.
 */
export function handleFeedbackGet(
  req: IncomingMessage,
  res: ServerResponse,
  feedbackDir: string,
): void {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const session = url.searchParams.get('session');

  if (!session || session.includes('..') || session.includes('/') || session.includes('\0')) {
    sendJson(res, 400, { error: 'bad_request', detail: 'session query parameter is required' });
    return;
  }

  const sessionFeedbackDir = join(feedbackDir, session);
  if (!existsSync(sessionFeedbackDir)) {
    sendJson(res, 200, { comments: [] });
    return;
  }

  let files: string[];
  try {
    files = readdirSync(sessionFeedbackDir)
      .filter((f) => f.endsWith('.md'))
      .sort();
  } catch (err) {
    sendJson(res, 500, { error: 'read_failed', detail: String(err) });
    return;
  }

  const comments: Record<string, unknown>[] = [];
  for (const filename of files) {
    const absPath = join(sessionFeedbackDir, filename);
    try {
      const raw = readFileSync(absPath, 'utf8');
      const parsed = matter(raw);
      comments.push({
        ...(parsed.data as Record<string, unknown>),
        body: parsed.content.trim(),
      });
    } catch (err) {
      // One corrupt/race-deleted comment file must not blank the whole panel.
      console.error(`[synergy] skipping unreadable feedback file ${filename}: ${String(err)}`);
    }
  }

  // Sort ascending by `created` field (ISO string sort is lexicographic == chronological).
  comments.sort((a, b) => {
    const ca = typeof a.created === 'string' ? a.created : '';
    const cb = typeof b.created === 'string' ? b.created : '';
    return ca < cb ? -1 : ca > cb ? 1 : 0;
  });

  sendJson(res, 200, { comments });
}

/**
 * Pure mutator: rewrite a comment file's frontmatter to resolved or rejected.
 *
 * Scans all session subdirectories of `feedbackDir` to locate `<id>.md`.
 * Throws if the file is not found.
 */
export function patchComment(
  feedbackDir: string,
  id: string,
  patch: { status: 'resolved' | 'rejected'; resolution?: string; rejection_reason?: string },
): void {
  // Guard the id at the core so both the single PATCH and the batch path are safe:
  // it is interpolated into a filename and joined onto disk paths.
  if (!id || id.includes('/') || id.includes('\\') || id.includes('..') || id.includes('\0')) {
    throw new Error(`invalid comment id: ${id}`);
  }
  const filename = `${id}.md`;
  let absPath: string | null = null;

  if (existsSync(feedbackDir)) {
    const sessions = readdirSync(feedbackDir);
    for (const session of sessions) {
      const candidate = join(feedbackDir, session, filename);
      if (existsSync(candidate)) {
        absPath = candidate;
        break;
      }
    }
  }

  if (!absPath) {
    throw new Error(`comment not found: ${id}`);
  }

  const raw = readFileSync(absPath, 'utf8');
  const parsed = matter(raw);
  const data = parsed.data as Record<string, unknown>;

  const now = new Date().toISOString();

  if (patch.status === 'resolved') {
    data.status = 'resolved';
    data.resolved_at = now;
    if (patch.resolution !== undefined) {
      data.resolution = patch.resolution;
    }
    // Remove rejection fields if any. `delete` (not `= undefined`) so the keys
    // are absent from the serialized YAML frontmatter, not emitted as null.
    // biome-ignore lint/performance/noDelete: key must be removed from YAML output, not nulled
    delete data.rejected_at;
    // biome-ignore lint/performance/noDelete: key must be removed from YAML output, not nulled
    delete data.rejection_reason;
  } else {
    data.status = 'rejected';
    data.rejected_at = now;
    if (patch.rejection_reason !== undefined) {
      data.rejection_reason = patch.rejection_reason;
    }
    // Remove resolution fields if any (see note above on `delete`).
    // biome-ignore lint/performance/noDelete: key must be removed from YAML output, not nulled
    delete data.resolved_at;
    // biome-ignore lint/performance/noDelete: key must be removed from YAML output, not nulled
    delete data.resolution;
  }

  // Reconstruct: write frontmatter back with gray-matter stringify, preserve body.
  const newContent = matter.stringify(parsed.content, data);
  atomicWrite(absPath, newContent);
}

/**
 * PATCH /api/feedback/:id — resolve or reject a comment.
 *
 * Rewrites only the frontmatter fields; the markdown body is preserved.
 */
export async function handleFeedbackPatch(
  req: IncomingMessage,
  res: ServerResponse,
  feedbackDir: string,
  id: string,
): Promise<void> {
  // id must be a valid comment id (no path separators)
  if (!id || id.includes('/') || id.includes('..') || id.includes('\0')) {
    sendJson(res, 400, { error: 'bad_id' });
    return;
  }

  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: 'invalid_json' });
    return;
  }

  if (!isFeedbackPatchRequest(body)) {
    sendJson(res, 400, {
      error: 'bad_request',
      detail: 'status must be "resolved" or "rejected"',
    });
    return;
  }

  try {
    patchComment(feedbackDir, id, body);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('not found')) {
      sendJson(res, 404, { error: 'not_found' });
    } else {
      sendJson(res, 500, { error: 'write_failed', detail: msg });
    }
    return;
  }

  sendJson(res, 200, { ok: true });
}
