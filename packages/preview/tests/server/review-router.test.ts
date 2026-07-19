import { describe, expect, it } from 'vitest';
import { matchReviewRoute } from '../../src/server/review-router.js';

describe('review router', () => {
  it('matches only complete safe review routes', () => {
    expect(matchReviewRoute('/api/reviews/workspace-a/revision-a/progress')).toEqual({
      kind: 'progress',
      reference: { workspaceId: 'workspace-a', revisionId: 'revision-a' },
    });
    expect(matchReviewRoute('/api/reviews/../revision-a')).toBeUndefined();
    expect(matchReviewRoute('/api/reviews/workspace-a/revision-a/unknown')).toBeUndefined();
  });

  it('rejects prototype keys, encoded traversal, and trailing separators', () => {
    expect(matchReviewRoute('/api/reviews/workspace-a/revision-a/toString')).toBeUndefined();
    expect(matchReviewRoute('/api/reviews/workspace-a/revision-a/__proto__')).toBeUndefined();
    expect(matchReviewRoute('/api/reviews/%2e%2e/revision-a')).toBeUndefined();
    expect(matchReviewRoute('/api/reviews/workspace-a/revision-a/')).toBeUndefined();
  });
});
