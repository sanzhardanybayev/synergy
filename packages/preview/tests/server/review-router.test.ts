import type { IncomingMessage, ServerResponse } from 'node:http';
import { createReviewStore } from '@synergy/review-core';
import { afterEach, describe, expect, it } from 'vitest';
import { handleReviewRouter, matchReviewRoute } from '../../src/server/review-router.js';
import { makeMockReq, makeMockRes, makeTempDir } from './helpers.js';

describe('review router', () => {
  it('matches only complete safe review routes', () => {
    expect(matchReviewRoute('/api/reviews/workspace-a/revision-a/progress')).toEqual({
      kind: 'progress',
      reference: { workspaceId: 'workspace-a', revisionId: 'revision-a' },
    });
    expect(matchReviewRoute('/api/reviews/../revision-a')).toBeUndefined();
    expect(matchReviewRoute('/api/reviews/workspace-a/revision-a/unknown')).toBeUndefined();
  });

  it('matches the index route for the exact reviews list path', () => {
    expect(matchReviewRoute('/api/reviews')).toEqual({ kind: 'index' });
    expect(matchReviewRoute('/api/reviews/')).toBeUndefined();
  });

  it('rejects prototype keys, encoded traversal, and trailing separators', () => {
    expect(matchReviewRoute('/api/reviews/workspace-a/revision-a/toString')).toBeUndefined();
    expect(matchReviewRoute('/api/reviews/workspace-a/revision-a/__proto__')).toBeUndefined();
    expect(matchReviewRoute('/api/reviews/%2e%2e/revision-a')).toBeUndefined();
    expect(matchReviewRoute('/api/reviews/workspace-a/revision-a/')).toBeUndefined();
  });

  describe('handleReviewRouter index dispatch', () => {
    let temp: ReturnType<typeof makeTempDir>;

    afterEach(() => temp?.cleanup());

    it('serves the review index on GET /api/reviews', async () => {
      temp = makeTempDir();
      const store = createReviewStore(temp.dir);
      const source = { kind: 'staged' as const, headSha: 'abc123' };
      store.createRevision(
        {
          schemaVersion: 1,
          id: 'workspace-a',
          repository: { root: '/repository', name: 'repository' },
          source,
          currentRevisionId: 'revision-a',
          createdAt: '2026-08-01T10:00:00.000Z',
          updatedAt: '2026-08-01T10:00:00.000Z',
        },
        {
          schemaVersion: 1,
          revisionId: 'revision-a',
          source,
          fingerprint: 'fingerprint',
          createdAt: '2026-08-01T10:00:00.000Z',
          kind: 'scope',
          files: [{ path: 'src/example.ts', binary: false, lines: [] }],
          items: [],
        },
        { schemaVersion: 1, revisionId: 'revision-a', groups: [], items: [] },
        { schemaVersion: 1, updatedAt: '2026-08-01T10:00:00.000Z', items: {} },
      );

      const req = makeMockReq({ method: 'GET', url: '/api/reviews' });
      const { res, result } = makeMockRes();
      await handleReviewRouter(
        req as unknown as IncomingMessage,
        res as unknown as ServerResponse,
        temp.dir,
      );

      expect(result().statusCode).toBe(200);
      expect(result().json).toMatchObject({
        reviews: [{ workspaceId: 'workspace-a', subject: 'Staged changes' }],
      });
    });

    it('rejects non-GET methods on the index route', async () => {
      temp = makeTempDir();
      const req = makeMockReq({ method: 'POST', url: '/api/reviews' });
      const { res, result } = makeMockRes();
      await handleReviewRouter(
        req as unknown as IncomingMessage,
        res as unknown as ServerResponse,
        temp.dir,
      );

      expect(result().statusCode).toBe(405);
    });
  });
});
