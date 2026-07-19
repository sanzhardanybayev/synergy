import { describe, expect, it } from 'vitest';
import { formatReviewRef, parseReviewRef } from '../src/index.js';

describe('review references', () => {
  it('round-trips a safe workspace and revision', () => {
    const value = formatReviewRef('mobile-app-pr-317', 'abc1234-def5678');

    expect(parseReviewRef(value)).toEqual({
      workspaceId: 'mobile-app-pr-317',
      revisionId: 'abc1234-def5678',
    });
  });

  it('rejects traversal in the workspace segment', () => {
    expect(() => parseReviewRef('../outside@abc')).toThrow('invalid review workspace');
  });

  it('rejects references without both segments', () => {
    expect(() => parseReviewRef('workspace')).toThrow(
      'review reference must be <workspace>@<revision>',
    );
  });
});
