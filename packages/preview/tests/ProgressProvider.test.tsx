import { describe, expect, it } from 'vitest';
import { buildExecView } from '../src/ProgressProvider.js';
import type { ProgressDto } from '../src/api.js';

const dto: ProgressDto = {
  progress: {
    version: 1,
    overallStatus: 'in-progress',
    resume: {},
    phases: [{ slug: 'storage', status: 'done' }],
  },
  derived: { done: 1, total: 2, percent: 50 },
  roster: [
    { number: 1, slug: 'storage', title: 'Storage layer', status: 'done' },
    { number: 2, slug: 'cutover', title: 'Cutover', status: 'proposed' },
  ],
  phaseJournals: {},
  globalJournal: null,
};

describe('buildExecView', () => {
  it('maps roster and derived onto the execution view', () => {
    const view = buildExecView(dto);
    expect(view.derived).toEqual({ done: 1, total: 2, percent: 50 });
    expect(view.roster).toEqual(dto.roster);
    expect(view.phases.storage?.status).toBe('done');
  });

  it('returns empty roster/derived for null data', () => {
    const view = buildExecView(null);
    expect(view.roster).toEqual([]);
    expect(view.derived).toEqual({ done: 0, total: 0, percent: 0 });
  });
});
