import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { readJsonBody, sendJson } from './http.js';
import { resolveSessionsRelative } from './paths.js';

// execFileSync is imported via function-level dynamic require to keep the
// module clean, since biome may warn on top-level imports from child_process.
import { execFileSync } from 'node:child_process';

interface ReviewRequest {
  file: string;
}

function isReviewRequest(v: unknown): v is ReviewRequest {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return typeof r.file === 'string' && r.file.length > 0;
}

interface ReviewStateEntry {
  commit: string;
  at: string;
}

type ReviewState = Record<string, ReviewStateEntry>;

function getHead(projectRoot: string): string {
  const out = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: projectRoot,
    encoding: 'utf8',
  });
  return out.trim();
}

/**
 * Check whether the working tree has uncommitted changes for `absFile`.
 * Returns true if there are uncommitted changes, false otherwise.
 */
function hasUncommittedChanges(absFile: string, projectRoot: string): boolean {
  try {
    execFileSync('git', ['diff', '--quiet', '--', absFile], {
      cwd: projectRoot,
      encoding: 'utf8',
    });
    return false; // exit 0 = no changes
  } catch {
    return true; // exit 1 = has changes, or git unavailable
  }
}

function atomicWriteJson(absPath: string, data: unknown): void {
  const tmpPath = join(dirname(absPath), `.${Date.now()}.tmp`);
  const content = JSON.stringify(data, null, 2);
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
 * POST /api/review — mark a file as reviewed at the current HEAD.
 *
 * Writes/updates `.synergy/review-state.json` atomically.
 */
export async function handleReview(
  req: IncomingMessage,
  res: ServerResponse,
  sessionsDir: string,
  projectRoot: string,
): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: 'invalid_json' });
    return;
  }

  if (!isReviewRequest(body)) {
    sendJson(res, 400, { error: 'bad_request', detail: 'file field is required' });
    return;
  }

  let absPath: string;
  try {
    absPath = resolveSessionsRelative(sessionsDir, body.file);
  } catch (err) {
    sendJson(res, 400, { error: 'bad_path', detail: String(err) });
    return;
  }

  let head: string;
  try {
    head = getHead(projectRoot);
  } catch {
    sendJson(res, 200, { error: 'not_a_git_repo' });
    return;
  }

  const reviewStatePath = join(projectRoot, '.synergy', 'review-state.json');
  let reviewState: ReviewState = {};
  if (existsSync(reviewStatePath)) {
    try {
      reviewState = JSON.parse(readFileSync(reviewStatePath, 'utf8')) as ReviewState;
    } catch (err) {
      // Do NOT silently reset on the write path — that would destroy every other
      // file's review cursor. Surface the corruption instead.
      sendJson(res, 500, { error: 'review_state_corrupt', detail: String(err) });
      return;
    }
  }

  const now = new Date().toISOString();
  // Key by path relative to projectRoot (consistent with diff.ts read).
  const relFromRoot = absPath.slice(projectRoot.length).replace(/^[\\/]/, '');
  reviewState[relFromRoot] = { commit: head, at: now };

  mkdirSync(join(projectRoot, '.synergy'), { recursive: true });
  try {
    atomicWriteJson(reviewStatePath, reviewState);
  } catch (err) {
    sendJson(res, 500, { error: 'write_failed', detail: String(err) });
    return;
  }

  const uncommitted = hasUncommittedChanges(absPath, projectRoot);
  const result: Record<string, unknown> = { ok: true, reviewedAt: head };
  if (uncommitted) {
    result.warn = 'uncommitted_changes_present';
  }
  sendJson(res, 200, result);
}
