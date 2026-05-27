import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFinding, setPhaseStatus, setResume } from './mutations.js';
import { globalJournalPath, phaseJournalPath } from './paths.js';
import { readProgress } from './progress.js';

let sessionDir: string;
const now = () => '2026-05-27T10:00:00.000Z';

beforeEach(() => {
  sessionDir = mkdtempSync(join(tmpdir(), 'synergy-mut-'));
});
afterEach(() => {
  rmSync(sessionDir, { recursive: true, force: true });
});

describe('setPhaseStatus', () => {
  it('inserts a new phase and stamps startedAt for in-progress', () => {
    setPhaseStatus(sessionDir, 'storage', 'in-progress', { now });
    const p = readProgress(sessionDir);
    expect(p.phases).toEqual([
      { slug: 'storage', status: 'in-progress', startedAt: now(), updatedAt: now() },
    ]);
  });

  it('stamps completedAt for done and keeps the existing startedAt', () => {
    setPhaseStatus(sessionDir, 'storage', 'in-progress', { now: () => '2026-05-27T09:00:00.000Z' });
    setPhaseStatus(sessionDir, 'storage', 'done', { now });
    const phase = readProgress(sessionDir).phases[0]!;
    expect(phase.status).toBe('done');
    expect(phase.startedAt).toBe('2026-05-27T09:00:00.000Z');
    expect(phase.completedAt).toBe(now());
  });

  it('writes a boundary note to the phase journal when --note is given', () => {
    setPhaseStatus(sessionDir, 'storage', 'done', { now, note: 'dual-write live' });
    const journal = readFileSync(phaseJournalPath(sessionDir, 'storage'), 'utf8');
    expect(journal).toContain('done');
    expect(journal).toContain('dual-write live');
    expect(journal).toContain(now());
  });
});

describe('appendFinding', () => {
  it('appends a phase finding as a bullet line', () => {
    appendFinding(sessionDir, { phase: 'storage' }, 'null exp rows backfilled', now);
    const journal = readFileSync(phaseJournalPath(sessionDir, 'storage'), 'utf8');
    expect(journal).toBe(`- ${now()}: null exp rows backfilled\n`);
  });

  it('appends a global finding to journal.md', () => {
    appendFinding(sessionDir, { global: true }, 'auth cache TTL = 300s', now);
    const journal = readFileSync(globalJournalPath(sessionDir), 'utf8');
    expect(journal).toContain('auth cache TTL = 300s');
  });
});

describe('setResume', () => {
  it('stores the resume pointer', () => {
    setResume(sessionDir, { nextPhase: 'cutover', note: 'begin canary 1%' }, now);
    expect(readProgress(sessionDir).resume).toEqual({
      nextPhase: 'cutover',
      note: 'begin canary 1%',
    });
  });

  it('merges — updating only the note preserves an existing nextPhase', () => {
    setResume(sessionDir, { nextPhase: 'cutover', note: 'canary 1%' }, now);
    setResume(sessionDir, { note: 'canary 10%' }, now);
    expect(readProgress(sessionDir).resume).toEqual({ nextPhase: 'cutover', note: 'canary 10%' });
  });

  it('merges — updating only nextPhase preserves an existing note', () => {
    setResume(sessionDir, { nextPhase: 'cutover', note: 'canary 1%' }, now);
    setResume(sessionDir, { nextPhase: 'cleanup' }, now);
    expect(readProgress(sessionDir).resume).toEqual({ nextPhase: 'cleanup', note: 'canary 1%' });
  });
});
