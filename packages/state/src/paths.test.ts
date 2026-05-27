import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { globalJournalPath, phaseJournalPath, progressPath, stateDir } from './paths.js';

const SESSION = '/proj/.synergy/sessions/refactor-auth';

describe('state paths', () => {
  it('stateDir is <session>/.state', () => {
    expect(stateDir(SESSION)).toBe(join(SESSION, '.state'));
  });
  it('progressPath is <session>/.state/progress.json', () => {
    expect(progressPath(SESSION)).toBe(join(SESSION, '.state', 'progress.json'));
  });
  it('phaseJournalPath is <session>/.state/phases/<id>.md', () => {
    expect(phaseJournalPath(SESSION, 'cutover')).toBe(
      join(SESSION, '.state', 'phases', 'cutover.md'),
    );
  });
  it('globalJournalPath is <session>/.state/journal.md', () => {
    expect(globalJournalPath(SESSION)).toBe(join(SESSION, '.state', 'journal.md'));
  });
});
