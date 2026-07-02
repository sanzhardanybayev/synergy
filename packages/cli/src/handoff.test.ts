import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readProgress } from '@synergy/state';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handoffSet } from './execstate.js';

let root: string;
let session: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'synergy-cli-ho-'));
  session = 'demo';
  mkdirSync(join(root, '.synergy', 'sessions', session), { recursive: true });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('handoffSet', () => {
  it('writes handoff.md and points the resume note at it', () => {
    handoffSet({ root, session, body: '## Next\nWire dual-write.\n', next: 'storage' });
    const dir = join(root, '.synergy', 'sessions', session);
    const ho = join(dir, '.state', 'handoff.md');
    expect(existsSync(ho)).toBe(true);
    expect(readFileSync(ho, 'utf8')).toContain('Wire dual-write.');
    const progress = readProgress(dir);
    expect(progress.resume.nextPhase).toBe('storage');
    expect(progress.resume.note).toContain('handoff.md');
  });

  it('throws for an unknown session', () => {
    expect(() => handoffSet({ root, session: 'nope', body: 'x' })).toThrow(/not found/);
  });
});
