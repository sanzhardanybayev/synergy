import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

function writePhaseFolder(
  sessionsDir: string,
  session: string,
  nn: string,
  slug: string,
  title: string | null,
) {
  const dir = join(sessionsDir, session, 'phases', `${nn}-${slug}`);
  mkdirSync(dir, { recursive: true });
  const fm = title === null ? '---\norder: 1\n---\n' : `---\ntitle: '${title}'\norder: 1\n---\n`;
  writeFileSync(join(dir, 'spec.mdx'), `${fm}\n# ${slug}\n`, 'utf8');
}

describe('buildProgressResponse — roster', () => {
  it('builds an ordered roster from phase folders, merging live status', () => {
    const sessionDir = join(sessionsDir, SESSION);
    writePhaseFolder(sessionsDir, SESSION, '01', 'storage', 'Storage layer');
    writePhaseFolder(sessionsDir, SESSION, '02', 'cutover', 'Cutover to new store');
    writePhaseFolder(sessionsDir, SESSION, '03', 'rollout', 'Gradual rollout');
    setPhaseStatus(sessionDir, 'storage', 'done');
    setPhaseStatus(sessionDir, 'cutover', 'in-progress');

    const res = buildProgressResponse(sessionsDir, SESSION);
    expect(res.roster).toEqual([
      { number: 1, slug: 'storage', title: 'Storage layer', status: 'done' },
      { number: 2, slug: 'cutover', title: 'Cutover to new store', status: 'in-progress' },
      { number: 3, slug: 'rollout', title: 'Gradual rollout', status: 'proposed' },
    ]);
    expect(res.derived).toEqual({ done: 1, total: 3, percent: 33 });
  });

  it('falls back to the slug when a phase spec has no title', () => {
    writePhaseFolder(sessionsDir, SESSION, '01', 'storage', null);
    const res = buildProgressResponse(sessionsDir, SESSION);
    expect(res.roster[0]).toEqual({
      number: 1,
      slug: 'storage',
      title: 'storage',
      status: 'proposed',
    });
  });

  it('returns an empty roster and legacy derived when there are no phase folders', () => {
    const sessionDir = join(sessionsDir, SESSION);
    setPhaseStatus(sessionDir, 'storage', 'done');
    const res = buildProgressResponse(sessionsDir, SESSION);
    expect(res.roster).toEqual([]);
    expect(res.derived).toEqual({ done: 1, total: 1, percent: 100 });
  });
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
