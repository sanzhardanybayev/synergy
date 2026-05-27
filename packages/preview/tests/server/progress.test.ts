import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendFinding, setPhaseStatus } from '@synergy/state';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildProgressResponse } from '../../src/server/progress.js';

let sessionsDir: string;
const SESSION = 'refactor-auth';

beforeEach(() => {
  sessionsDir = mkdtempSync(join(tmpdir(), 'synergy-prog-'));
});
afterEach(() => {
  rmSync(sessionsDir, { recursive: true, force: true });
});

describe('buildProgressResponse', () => {
  it('returns derived rollup + per-phase journals + global journal', () => {
    const sessionDir = join(sessionsDir, SESSION);
    setPhaseStatus(sessionDir, 'storage', 'done', { note: 'dual-write live' });
    setPhaseStatus(sessionDir, 'cutover', 'in-progress');
    appendFinding(sessionDir, { global: true }, 'cache TTL 300s');

    const res = buildProgressResponse(sessionsDir, SESSION);
    expect(res.derived).toEqual({ done: 1, total: 2, percent: 50 });
    expect(res.phaseJournals.storage).toContain('dual-write live');
    expect(res.globalJournal).toContain('cache TTL 300s');
    expect(res.progress.phases.map((p) => p.slug)).toEqual(['storage', 'cutover']);
  });

  it('rejects a session with a path separator', () => {
    expect(() => buildProgressResponse(sessionsDir, '../escape')).toThrow();
  });
});
