import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readGlobalJournal, readPhaseJournal } from './journals.js';
import { appendFinding } from './mutations.js';

let sessionDir: string;
beforeEach(() => {
  sessionDir = mkdtempSync(join(tmpdir(), 'synergy-jrnl-'));
});
afterEach(() => {
  rmSync(sessionDir, { recursive: true, force: true });
});

describe('journal readers', () => {
  it('returns null when a phase journal is absent', () => {
    expect(readPhaseJournal(sessionDir, 'storage')).toBeNull();
  });
  it('reads a phase journal that exists', () => {
    appendFinding(sessionDir, { phase: 'storage' }, 'a finding', () => 'T');
    expect(readPhaseJournal(sessionDir, 'storage')).toContain('a finding');
  });
  it('returns null when the global journal is absent', () => {
    expect(readGlobalJournal(sessionDir)).toBeNull();
  });
});
