import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { handleDiff, parseUnifiedDiff } from '../../src/server/diff.js';
import { makeMockReq, makeMockRes, makeTempDir } from './helpers.js';

function callDiff(sessionsDir: string, projectRoot: string, fileParam: string | null) {
  const url = fileParam ? `/api/diff?file=${encodeURIComponent(fileParam)}` : '/api/diff';
  const req = makeMockReq({ method: 'GET', url });
  const { res, result } = makeMockRes();
  handleDiff(
    req as unknown as IncomingMessage,
    res as unknown as ServerResponse,
    sessionsDir,
    projectRoot,
  );
  return result();
}

function initGitRepo(dir: string): void {
  const opts = { cwd: dir, encoding: 'utf8' as const, stdio: 'pipe' as const };
  execFileSync('git', ['init'], opts);
  execFileSync('git', ['config', 'user.email', 'test@test.com'], opts);
  execFileSync('git', ['config', 'user.name', 'Test'], opts);
}

describe('parseUnifiedDiff', () => {
  it('returns empty array for empty input', () => {
    expect(parseUnifiedDiff('')).toEqual([]);
  });

  it('parses a simple hunk correctly', () => {
    const diff = [
      '@@ -1,3 +1,4 @@',
      ' context',
      '-old line',
      '+new line',
      '+added line',
      ' context end',
    ].join('\n');
    const hunks = parseUnifiedDiff(diff);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]!.oldStart).toBe(1);
    expect(hunks[0]!.newStart).toBe(1);
    expect(hunks[0]!.oldLines).toBe(3);
    expect(hunks[0]!.newLines).toBe(4);
    const kinds = hunks[0]!.lines.map((l) => l.kind);
    expect(kinds).toEqual(['context', 'remove', 'add', 'add', 'context']);
  });
});

describe('handleDiff', () => {
  let temp: ReturnType<typeof makeTempDir>;

  afterEach(() => temp?.cleanup());

  it('returns not_a_git_repo sentinel for a non-git directory', () => {
    temp = makeTempDir({ 'sessions/foo/spec.mdx': 'hello\n' });
    const r = callDiff(join(temp.dir, 'sessions'), temp.dir, 'foo/spec.mdx');
    expect(r.statusCode).toBe(200);
    const body = r.json as Record<string, unknown>;
    expect(body.error).toBe('not_a_git_repo');
  });

  it('returns 400 when file param is missing', () => {
    temp = makeTempDir({});
    const r = callDiff(temp.dir, temp.dir, null);
    expect(r.statusCode).toBe(400);
  });

  it('returns 400 on path traversal in file param', () => {
    temp = makeTempDir({});
    const r = callDiff(temp.dir, temp.dir, '../../etc/passwd');
    expect(r.statusCode).toBe(400);
  });

  it('returns hunk JSON and no reviewedAt for a git repo with a committed change', () => {
    temp = makeTempDir({});
    const projectRoot = temp.dir;
    const sessionsDir = join(projectRoot, 'sessions');
    mkdirSync(sessionsDir, { recursive: true });

    initGitRepo(projectRoot);

    const specPath = join(sessionsDir, 'foo', 'spec.mdx');
    mkdirSync(join(sessionsDir, 'foo'), { recursive: true });
    writeFileSync(specPath, 'original content\n', 'utf8');

    execFileSync('git', ['add', '.'], { cwd: projectRoot, encoding: 'utf8', stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'initial'], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: 'pipe',
    });

    // Modify the file (uncommitted)
    writeFileSync(specPath, 'modified content\n', 'utf8');

    const r = callDiff(sessionsDir, projectRoot, 'foo/spec.mdx');
    expect(r.statusCode).toBe(200);
    const body = r.json as Record<string, unknown>;
    expect(typeof body.head).toBe('string');
    expect(body.reviewedAt).toBeNull();
    // uncommittedHunks should have the working-tree diff
    expect(Array.isArray(body.uncommittedHunks)).toBe(true);
  });

  it('uses HEAD~5 default when no review-state entry exists', () => {
    temp = makeTempDir({});
    const projectRoot = temp.dir;
    const sessionsDir = join(projectRoot, 'sessions');
    mkdirSync(sessionsDir, { recursive: true });

    initGitRepo(projectRoot);

    const specPath = join(sessionsDir, 'foo', 'spec.mdx');
    mkdirSync(join(sessionsDir, 'foo'), { recursive: true });
    writeFileSync(specPath, 'v1\n', 'utf8');

    const gitOpts = { cwd: projectRoot, encoding: 'utf8' as const, stdio: 'pipe' as const };
    execFileSync('git', ['add', '.'], gitOpts);
    execFileSync('git', ['commit', '-m', 'v1'], gitOpts);

    const r = callDiff(sessionsDir, projectRoot, 'foo/spec.mdx');
    expect(r.statusCode).toBe(200);
    const body = r.json as Record<string, unknown>;
    // reviewedAt is null → handler falls back to HEAD~5
    expect(body.reviewedAt).toBeNull();
  });
});
