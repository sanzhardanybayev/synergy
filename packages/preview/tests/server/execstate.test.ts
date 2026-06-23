import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readProgress } from '@synergy/state';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyLog,
  applyPhaseSet,
  applyResume,
  assertSafeSession,
} from '../../src/server/execstate.js';

let sessionsDir: string;
const SESSION = 'refactor-auth';

beforeEach(() => {
  sessionsDir = mkdtempSync(join(tmpdir(), 'synergy-exec-'));
});
afterEach(() => rmSync(sessionsDir, { recursive: true, force: true }));

describe('execstate cores', () => {
  it('applyPhaseSet writes status + boundary note identically to the CLI path', () => {
    applyPhaseSet(sessionsDir, {
      session: SESSION,
      phaseId: 'storage',
      status: 'done',
      note: 'dual-write live',
    });
    const progress = readProgress(join(sessionsDir, SESSION));
    expect(progress.phases.find((p) => p.slug === 'storage')?.status).toBe('done');
    const journal = readFileSync(
      join(sessionsDir, SESSION, '.state', 'phases', 'storage.md'),
      'utf8',
    );
    expect(journal).toContain('dual-write live');
  });

  it('applyPhaseSet rejects an invalid status', () => {
    expect(() =>
      applyPhaseSet(sessionsDir, { session: SESSION, phaseId: 'storage', status: 'nope' as never }),
    ).toThrow(/invalid status/);
  });

  it('applyLog requires a target', () => {
    expect(() => applyLog(sessionsDir, { session: SESSION, text: 'x' })).toThrow(
      /--phase or --global/,
    );
  });

  it('applyResume sets the hand-off pointer', () => {
    applyResume(sessionsDir, { session: SESSION, next: 'cutover', note: 'start here' });
    const progress = readProgress(join(sessionsDir, SESSION));
    expect(progress.resume.nextPhase).toBe('cutover');
    expect(progress.resume.note).toBe('start here');
  });

  it('assertSafeSession rejects traversal', () => {
    expect(() => assertSafeSession('../escape')).toThrow();
    expect(() => assertSafeSession('ok-name')).not.toThrow();
  });
});
