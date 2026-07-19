import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initProject } from './init.js';

describe('initProject', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = join(tmpdir(), `synergy-init-test-${Date.now()}`);
    mkdirSync(tmpRoot, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('creates .synergy/sessions/ directory', () => {
    initProject(tmpRoot);
    expect(existsSync(join(tmpRoot, '.synergy', 'sessions'))).toBe(true);
  });

  it('writes .gitignore with all required local-artifact entries', () => {
    initProject(tmpRoot);
    const gitignore = readFileSync(join(tmpRoot, '.synergy', '.gitignore'), 'utf8');
    expect(gitignore).toContain('preview.runtime.json');
    expect(gitignore).toContain('preview.runtime.json.mutation.lock');
    expect(gitignore).toContain('preview.start.lock');
    expect(gitignore).toContain('preview.pid');
    expect(gitignore).toContain('preview.log');
    expect(gitignore).toContain('active-session');
    expect(gitignore).toContain('review-state.json');
    expect(gitignore).toContain('reviews/');
    expect(gitignore).toContain('active-review.json');
  });

  it('returns the synergyDir path', () => {
    const result = initProject(tmpRoot);
    expect(result.synergyDir).toBe(join(tmpRoot, '.synergy'));
  });

  it('is idempotent — calling twice does not throw', () => {
    expect(() => {
      initProject(tmpRoot);
      initProject(tmpRoot);
    }).not.toThrow();
  });
});
