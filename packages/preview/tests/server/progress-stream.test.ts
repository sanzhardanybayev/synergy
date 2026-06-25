import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setPhaseStatus } from '@synergy/state';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { formatSseFrame, initialFrame } from '../../src/server/progress-stream.js';

let sessionsDir: string;
beforeEach(() => {
  sessionsDir = mkdtempSync(join(tmpdir(), 'synergy-sse-'));
});
afterEach(() => {
  rmSync(sessionsDir, { recursive: true, force: true });
});

describe('progress-stream framing', () => {
  it('formats an SSE data frame terminated by a blank line', () => {
    const frame = formatSseFrame({ a: 1 });
    expect(frame).toBe('data: {"a":1}\n\n');
  });

  it('initialFrame embeds the current progress payload', () => {
    setPhaseStatus(join(sessionsDir, 'demo'), 'storage', 'done');
    const frame = initialFrame(sessionsDir, 'demo');
    expect(frame.startsWith('data: ')).toBe(true);
    expect(frame.endsWith('\n\n')).toBe(true);
    expect(JSON.parse(frame.slice('data: '.length).trim()).derived).toBeDefined();
  });
});
