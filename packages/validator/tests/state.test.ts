import { afterEach, describe, expect, it } from 'vitest';
import { validate } from '../src/validate.js';
import { makeTempProject, minimalOverview, minimalPhaseSpec } from './helpers.js';

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups) fn();
  cleanups = [];
});
function project(files: Record<string, string>): string {
  const { projectRoot, cleanup } = makeTempProject(files);
  cleanups.push(cleanup);
  return projectRoot;
}

const S = '.synergy/sessions/s1';

describe('validate — .state/progress.json', () => {
  it('errors when progress.json is malformed JSON', () => {
    const root = project({
      [`${S}/00-overview.mdx`]: minimalOverview('t'),
      [`${S}/phases/01-storage/spec.mdx`]: minimalPhaseSpec('Storage', 1),
      [`${S}/.state/progress.json`]: '{ not json',
    });
    const report = validate({ projectRoot: root });
    expect(
      report.issues.some((i) => i.severity === 'error' && /progress\.json/.test(i.message)),
    ).toBe(true);
  });

  it('errors when progress.json references an unknown phase slug', () => {
    const root = project({
      [`${S}/00-overview.mdx`]: minimalOverview('t'),
      [`${S}/phases/01-storage/spec.mdx`]: minimalPhaseSpec('Storage', 1),
      [`${S}/.state/progress.json`]: JSON.stringify({
        version: 1,
        phases: [{ slug: 'ghost', status: 'done' }],
      }),
    });
    const report = validate({ projectRoot: root });
    expect(report.issues.some((i) => i.severity === 'error' && /ghost/.test(i.message))).toBe(true);
  });

  it('passes when progress.json slugs match known phase ids', () => {
    const root = project({
      [`${S}/00-overview.mdx`]: minimalOverview('t'),
      [`${S}/phases/01-storage/spec.mdx`]: minimalPhaseSpec('Storage', 1),
      [`${S}/.state/progress.json`]: JSON.stringify({
        version: 1,
        phases: [{ slug: 'storage', status: 'done' }],
      }),
    });
    const report = validate({ projectRoot: root });
    expect(report.issues.filter((i) => i.severity === 'error')).toEqual([]);
  });
});
