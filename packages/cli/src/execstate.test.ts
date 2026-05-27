import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readProgress } from '@synergy/state';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { logFinding, phaseSet, printProgress, resumeSet } from './execstate.js';

let root: string;
let sessionDir: string;
const SESSION = 'refactor-auth';

beforeEach(() => {
  root = join(tmpdir(), `synergy-cli-state-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  sessionDir = join(root, '.synergy', 'sessions', SESSION);
  mkdirSync(sessionDir, { recursive: true });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('phaseSet', () => {
  it('writes phase status into .state/progress.json', () => {
    phaseSet({
      root,
      session: SESSION,
      phaseId: 'storage',
      status: 'done',
      note: 'dual-write live',
    });
    const p = readProgress(sessionDir);
    expect(p.phases.find((x) => x.slug === 'storage')?.status).toBe('done');
    const journal = readFileSync(join(sessionDir, '.state', 'phases', 'storage.md'), 'utf8');
    expect(journal).toContain('dual-write live');
  });

  it('rejects an invalid status', () => {
    expect(() =>
      phaseSet({ root, session: SESSION, phaseId: 'storage', status: 'nope' as never }),
    ).toThrow(/invalid status/i);
  });

  it('rejects an unknown session directory', () => {
    expect(() => phaseSet({ root, session: 'ghost', phaseId: 'storage', status: 'done' })).toThrow(
      /session/i,
    );
  });
});

describe('logFinding', () => {
  it('appends a global finding', () => {
    logFinding({ root, session: SESSION, text: 'cache TTL 300s', global: true });
    const journal = readFileSync(join(sessionDir, '.state', 'journal.md'), 'utf8');
    expect(journal).toContain('cache TTL 300s');
  });
  it('requires either --phase or --global', () => {
    expect(() => logFinding({ root, session: SESSION, text: 'x' })).toThrow(/--phase or --global/i);
  });
});

describe('resumeSet', () => {
  it('stores the resume pointer', () => {
    resumeSet({ root, session: SESSION, next: 'cutover', note: 'canary 1%' });
    expect(readProgress(sessionDir).resume).toEqual({ nextPhase: 'cutover', note: 'canary 1%' });
  });
});

describe('printProgress', () => {
  it('returns a summary string with the derived rollup', () => {
    phaseSet({ root, session: SESSION, phaseId: 'storage', status: 'done' });
    phaseSet({ root, session: SESSION, phaseId: 'cutover', status: 'in-progress' });
    const out = printProgress({ root, session: SESSION });
    expect(out).toContain('1/2');
    expect(out).toContain('cutover');
  });
});
