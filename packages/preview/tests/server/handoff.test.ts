import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readProgress } from '@synergy/state';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyHandoff } from '../../src/server/execstate.js';

let sessionsDir: string;
beforeEach(() => {
  sessionsDir = mkdtempSync(join(tmpdir(), 'synergy-srv-ho-'));
});
afterEach(() => {
  rmSync(sessionsDir, { recursive: true, force: true });
});

describe('applyHandoff', () => {
  it('writes handoff.md + resume note for a valid session', () => {
    applyHandoff(sessionsDir, { session: 'demo', body: '## Next\nwire it', next: 'storage' });
    const dir = join(sessionsDir, 'demo');
    expect(existsSync(join(dir, '.state', 'handoff.md'))).toBe(true);
    expect(readFileSync(join(dir, '.state', 'handoff.md'), 'utf8')).toContain('wire it');
    expect(readProgress(dir).resume.note).toContain('handoff.md');
  });

  it('rejects an unsafe session name', () => {
    expect(() => applyHandoff(sessionsDir, { session: '../evil', body: 'x' })).toThrow(
      /invalid session/,
    );
  });
});
