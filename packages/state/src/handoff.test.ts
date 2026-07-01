import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handoffPath, readHandoff, writeHandoff } from './handoff.js';

let sessionDir: string;
beforeEach(() => {
  sessionDir = mkdtempSync(join(tmpdir(), 'synergy-ho-'));
});
afterEach(() => {
  rmSync(sessionDir, { recursive: true, force: true });
});

const fixedNow = () => '2026-07-02T12:00:00.000Z';

describe('handoff', () => {
  it('returns null when no handoff exists', () => {
    expect(readHandoff(sessionDir)).toBeNull();
  });

  it('writes a handoff with a timestamped heading and reads it back', () => {
    writeHandoff(sessionDir, '## What I did\nStuff.\n', fixedNow);
    const body = readHandoff(sessionDir);
    expect(body).not.toBeNull();
    expect(body).toContain('# Handoff — 2026-07-02T12:00:00.000Z');
    expect(body).toContain('## What I did');
  });

  it('overwrites (latest-wins) on a second write', () => {
    writeHandoff(sessionDir, 'first', () => '2026-07-02T12:00:00.000Z');
    writeHandoff(sessionDir, 'second', () => '2026-07-02T13:00:00.000Z');
    const body = readHandoff(sessionDir) ?? '';
    expect(body).toContain('second');
    expect(body).not.toContain('first');
    expect(body).toContain('13:00:00');
  });

  it('handoffPath points inside .state', () => {
    expect(handoffPath(sessionDir)).toBe(join(sessionDir, '.state', 'handoff.md'));
  });
});
