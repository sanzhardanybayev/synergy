import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { handleReview } from '../../src/server/review.js';
import { makeMockReq, makeMockRes, makeTempDir } from './helpers.js';

async function callReview(sessionsDir: string, projectRoot: string, body: unknown) {
  const req = makeMockReq({ method: 'POST', url: '/api/review', body });
  const { res, result } = makeMockRes();
  await handleReview(
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

describe('handleReview', () => {
  let temp: ReturnType<typeof makeTempDir>;

  afterEach(() => temp?.cleanup());

  it('writes review-state.json atomically with correct entry', async () => {
    temp = makeTempDir({});
    const projectRoot = temp.dir;
    const sessionsDir = join(projectRoot, 'sessions');
    mkdirSync(sessionsDir, { recursive: true });

    initGitRepo(projectRoot);

    const specPath = join(sessionsDir, 'foo', 'spec.mdx');
    mkdirSync(join(sessionsDir, 'foo'), { recursive: true });
    writeFileSync(specPath, 'content\n', 'utf8');

    const gitOpts = { cwd: projectRoot, encoding: 'utf8' as const, stdio: 'pipe' as const };
    execFileSync('git', ['add', '.'], gitOpts);
    execFileSync('git', ['commit', '-m', 'init'], gitOpts);

    const r = await callReview(sessionsDir, projectRoot, { file: 'foo/spec.mdx' });
    expect(r.statusCode).toBe(200);
    const body = r.json as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(typeof body.reviewedAt).toBe('string');

    const reviewStatePath = join(projectRoot, '.synergy', 'review-state.json');
    expect(existsSync(reviewStatePath)).toBe(true);
    const state = JSON.parse(readFileSync(reviewStatePath, 'utf8')) as Record<string, unknown>;
    const keys = Object.keys(state);
    expect(keys.length).toBeGreaterThan(0);
    const entry = state[keys[0]!] as Record<string, unknown>;
    expect(typeof entry.commit).toBe('string');
    expect(typeof entry.at).toBe('string');
  });

  it('merges new entry without disturbing existing siblings', async () => {
    temp = makeTempDir({});
    const projectRoot = temp.dir;
    const sessionsDir = join(projectRoot, 'sessions');
    mkdirSync(sessionsDir, { recursive: true });

    initGitRepo(projectRoot);

    // Create two spec files
    mkdirSync(join(sessionsDir, 'foo'), { recursive: true });
    writeFileSync(join(sessionsDir, 'foo', 'spec.mdx'), 'a\n', 'utf8');
    writeFileSync(join(sessionsDir, 'foo', 'other.mdx'), 'b\n', 'utf8');

    const gitOpts = { cwd: projectRoot, encoding: 'utf8' as const, stdio: 'pipe' as const };
    execFileSync('git', ['add', '.'], gitOpts);
    execFileSync('git', ['commit', '-m', 'init'], gitOpts);

    // Seed an existing review-state.json with a sibling entry
    const reviewStatePath = join(projectRoot, '.synergy', 'review-state.json');
    mkdirSync(join(projectRoot, '.synergy'), { recursive: true });
    writeFileSync(
      reviewStatePath,
      JSON.stringify({
        'sessions/foo/other.mdx': { commit: 'abc123', at: '2026-01-01T00:00:00Z' },
      }),
      'utf8',
    );

    await callReview(sessionsDir, projectRoot, { file: 'foo/spec.mdx' });

    const state = JSON.parse(readFileSync(reviewStatePath, 'utf8')) as Record<string, unknown>;
    // Sibling preserved
    expect(state['sessions/foo/other.mdx']).toBeDefined();
    const sibling = state['sessions/foo/other.mdx'] as Record<string, unknown>;
    expect(sibling.commit).toBe('abc123');
    // New entry added
    const newKey = Object.keys(state).find((k) => k.includes('spec.mdx'));
    expect(newKey).toBeDefined();
  });

  it('returns not_a_git_repo sentinel gracefully for non-git dir', async () => {
    temp = makeTempDir({ 'sessions/foo/spec.mdx': 'content\n' });
    const r = await callReview(join(temp.dir, 'sessions'), temp.dir, { file: 'foo/spec.mdx' });
    expect(r.statusCode).toBe(200);
    const body = r.json as Record<string, unknown>;
    expect(body.error).toBe('not_a_git_repo');
  });

  it('returns 400 on missing file field', async () => {
    temp = makeTempDir({});
    const r = await callReview(temp.dir, temp.dir, { other: 'field' });
    expect(r.statusCode).toBe(400);
  });
});
