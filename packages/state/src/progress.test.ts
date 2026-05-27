import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { progressPath } from './paths.js';
import { deriveProgress, emptyProgress, readProgress, writeProgress } from './progress.js';

let sessionDir: string;

beforeEach(() => {
  sessionDir = mkdtempSync(join(tmpdir(), 'synergy-state-'));
});
afterEach(() => {
  rmSync(sessionDir, { recursive: true, force: true });
});

describe('readProgress', () => {
  it('returns an empty progress when the file is absent', () => {
    const p = readProgress(sessionDir);
    expect(p.version).toBe(1);
    expect(p.phases).toEqual([]);
    expect(p.resume).toEqual({});
  });
});

describe('writeProgress', () => {
  it('creates .state/progress.json and round-trips', () => {
    const p = emptyProgress();
    p.phases.push({ slug: 'storage', status: 'done' });
    writeProgress(sessionDir, p);
    expect(existsSync(progressPath(sessionDir))).toBe(true);
    const round = readProgress(sessionDir);
    expect(round.phases).toEqual([{ slug: 'storage', status: 'done' }]);
  });

  it('writes indented JSON', () => {
    writeProgress(sessionDir, emptyProgress());
    const raw = readFileSync(progressPath(sessionDir), 'utf8');
    expect(raw).toContain('\n  ');
  });
});

describe('deriveProgress', () => {
  it('counts done + shipped as done and rounds percent', () => {
    const p = emptyProgress();
    p.phases.push(
      { slug: 'a', status: 'done' },
      { slug: 'b', status: 'shipped' },
      { slug: 'c', status: 'in-progress' },
    );
    expect(deriveProgress(p)).toEqual({ done: 2, total: 3, percent: 67 });
  });

  it('is 0/0/0 with no phases', () => {
    expect(deriveProgress(emptyProgress())).toEqual({ done: 0, total: 0, percent: 0 });
  });
});
