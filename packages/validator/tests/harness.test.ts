import { existsSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { makeTempProject, minimalOverview, minimalPhaseSpec } from './helpers.js';

/**
 * Smoke tests for the test harness itself — feature suites will build on
 * `makeTempProject` to stand up disposable session trees.
 */
describe('test harness', () => {
  let cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const fn of cleanups) fn();
    cleanups = [];
  });

  it('materializes files on disk and cleans them up', () => {
    const { projectRoot, cleanup } = makeTempProject({
      '.synergy/sessions/s1/00-overview.mdx': '# x',
    });
    cleanups.push(cleanup);
    expect(existsSync(`${projectRoot}/.synergy/sessions/s1/00-overview.mdx`)).toBe(true);
  });

  it('minimalOverview includes Summary and Goals headings', () => {
    const body = minimalOverview('Hi');
    expect(body).toContain('## Summary');
    expect(body).toContain('## Goals');
  });

  it('minimalPhaseSpec includes a Tasks heading', () => {
    const body = minimalPhaseSpec('Core', 2);
    expect(body).toContain('## Tasks');
    expect(body).toContain('Phase 2: Core');
  });
});
