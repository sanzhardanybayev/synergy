import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { sendJson } from './http.js';
import { resolveSessionsRelative } from './paths.js';

// All git invocations use execFileSync with an explicit argv array and cwd set
// to projectRoot. User input is never interpolated into a shell string.

interface DiffLine {
  kind: 'context' | 'add' | 'remove';
  text: string;
}

interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

interface DiffResponse {
  file: string;
  head: string;
  reviewedAt: string | null;
  hunks: DiffHunk[];
  uncommittedHunks: DiffHunk[];
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

export function parseUnifiedDiff(diffOutput: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  if (!diffOutput.trim()) return hunks;

  const lines = diffOutput.split('\n');
  let currentHunk: DiffHunk | null = null;

  const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

  for (const line of lines) {
    const hunkMatch = HUNK_HEADER_RE.exec(line);
    if (hunkMatch) {
      if (currentHunk) hunks.push(currentHunk);
      currentHunk = {
        oldStart: Number.parseInt(hunkMatch[1]!, 10),
        oldLines: hunkMatch[2] !== undefined ? Number.parseInt(hunkMatch[2], 10) : 1,
        newStart: Number.parseInt(hunkMatch[3]!, 10),
        newLines: hunkMatch[4] !== undefined ? Number.parseInt(hunkMatch[4], 10) : 1,
        lines: [],
      };
      continue;
    }
    if (!currentHunk) continue;

    if (line.startsWith('+') && !line.startsWith('+++')) {
      currentHunk.lines.push({ kind: 'add', text: line.slice(1) });
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      currentHunk.lines.push({ kind: 'remove', text: line.slice(1) });
    } else if (line.startsWith(' ')) {
      currentHunk.lines.push({ kind: 'context', text: line.slice(1) });
    }
  }

  if (currentHunk) hunks.push(currentHunk);
  return hunks;
}

function runGitDiff(args: string[], projectRoot: string): string {
  try {
    return execFileSync('git', ['diff', ...args], {
      cwd: projectRoot,
      encoding: 'utf8',
    });
  } catch {
    return '';
  }
}

/**
 * Resolve the base ref for the "since last review" diff when no review-state
 * entry exists. Defaults to 5 commits back, but a young repo with fewer than 6
 * commits has no `HEAD~5` — git errors, runGitDiff swallows it, and the view
 * silently shows "no changes". Fall back to the root commit instead. Returns
 * null when there is nothing to diff against (≤1 commit).
 */
function resolveDefaultBaseRef(projectRoot: string): string | null {
  try {
    const count = Number.parseInt(
      execFileSync('git', ['rev-list', '--count', 'HEAD'], {
        cwd: projectRoot,
        encoding: 'utf8',
      }).trim(),
      10,
    );
    if (!Number.isFinite(count) || count <= 1) return null;
    if (count > 5) return 'HEAD~5';
    const roots = execFileSync('git', ['rev-list', '--max-parents=0', 'HEAD'], {
      cwd: projectRoot,
      encoding: 'utf8',
    })
      .trim()
      .split('\n');
    return roots[roots.length - 1] ?? null;
  } catch {
    return null;
  }
}

export function handleDiff(
  req: IncomingMessage,
  res: ServerResponse,
  sessionsDir: string,
  projectRoot: string,
): void {
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
    } catch {
      reviewState = {};
    }
  }

  const relFromRoot = absPath.slice(projectRoot.length).replace(/^[\\/]/, '');
  const stateEntry = reviewState[relFromRoot] ?? reviewState[fileParam];
  const reviewedAt = stateEntry?.commit ?? null;

  const baseRef = reviewedAt ?? resolveDefaultBaseRef(projectRoot);
  const committedDiff = baseRef
    ? runGitDiff([`${baseRef}..${head}`, '--', absPath], projectRoot)
    : '';
  const hunks = parseUnifiedDiff(committedDiff);

  const uncommittedDiff = runGitDiff(['--', absPath], projectRoot);
  const uncommittedHunks = parseUnifiedDiff(uncommittedDiff);

  const response: DiffResponse = {
    file: fileParam,
    head,
    reviewedAt,
    hunks,
    uncommittedHunks,
  };
  sendJson(res, 200, response);
}
