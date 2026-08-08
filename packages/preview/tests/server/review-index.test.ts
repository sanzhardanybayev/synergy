import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type ReviewBundle,
  applyCodeSections,
  buildScopeSnapshot,
  createReviewStore,
} from '@synergy/review-core';
import { afterEach, describe, expect, it } from 'vitest';
import { buildReviewIndex } from '../../src/server/review-index.js';
import { makeTempDir } from './helpers.js';

function fixture(overrides: {
  workspaceId: string;
  revisionId: string;
  source: ReviewBundle['workspace']['source'];
  updatedAt: string;
  itemStatuses?: Array<'reviewed' | 'needs-review' | 'carried-forward'>;
}): ReviewBundle {
  const { workspaceId, revisionId, source, updatedAt, itemStatuses = ['needs-review'] } = overrides;
  const lines = itemStatuses.map((_, index) => ({
    number: index + 1,
    text: `export const value${index} = true;`,
  }));
  const baseSnapshot = buildScopeSnapshot({
    revisionId,
    source,
    fingerprint: 'fingerprint',
    createdAt: updatedAt,
    files: [{ path: 'src/example.ts', binary: false, lines }],
  });
  const snapshot = applyCodeSections(
    baseSnapshot,
    itemStatuses.map((_, index) => ({
      path: 'src/example.ts',
      label: `example ${index}`,
      start: index + 1,
      end: index + 1,
    })),
  );
  const items = snapshot.items;
  return {
    workspace: {
      schemaVersion: 1,
      id: workspaceId,
      repository: { root: '/repository', name: 'repository' },
      source,
      currentRevisionId: revisionId,
      createdAt: updatedAt,
      updatedAt,
    },
    snapshot,
    insights: {
      schemaVersion: 1,
      revisionId,
      groups: [{ id: 'group-a', label: 'Example', reviewItemIds: items.map((item) => item.id) }],
      items: items.map((item) => ({
        reviewItemId: item.id,
        description: 'An example change.',
        confidence: 'high',
        evidencePaths: ['src/example.ts'],
      })),
    },
    progress: {
      schemaVersion: 1,
      updatedAt,
      items: Object.fromEntries(
        items.map((item, index) => [
          item.id,
          {
            status: itemStatuses[index],
            ...(itemStatuses[index] === 'reviewed' ? { reviewedAt: updatedAt } : {}),
          },
        ]),
      ),
    },
    questions: [],
    answers: [],
    sourceChanged: false,
  };
}

describe('buildReviewIndex', () => {
  let temp: ReturnType<typeof makeTempDir>;

  afterEach(() => temp?.cleanup());

  it('lists workspaces with progress and subject labels, sorted by updatedAt desc', async () => {
    temp = makeTempDir();
    const store = createReviewStore(temp.dir);

    const staged = fixture({
      workspaceId: 'workspace-staged',
      revisionId: 'rev-1',
      source: { kind: 'staged', headSha: 'abc123' },
      updatedAt: '2026-08-01T10:00:00.000Z',
      itemStatuses: ['reviewed', 'needs-review'],
    });
    store.createRevision(staged.workspace, staged.snapshot, staged.insights, staged.progress);

    const pr = fixture({
      workspaceId: 'workspace-pr',
      revisionId: 'rev-1',
      source: {
        kind: 'pr',
        number: 317,
        url: 'https://example.com/pr/317',
        baseSha: 'a',
        headSha: 'b',
      },
      updatedAt: '2026-08-02T10:00:00.000Z',
      itemStatuses: ['reviewed'],
    });
    store.createRevision(pr.workspace, pr.snapshot, pr.insights, pr.progress);

    const result = await buildReviewIndex(temp.dir);

    expect(result.reviews).toHaveLength(2);
    expect(result.reviews[0]!.workspaceId).toBe('workspace-pr');
    expect(result.reviews[1]!.workspaceId).toBe('workspace-staged');
    expect(result.reviews[0]!.updatedAt >= result.reviews[1]!.updatedAt).toBe(true);
    expect(result.reviews.map((r) => r.subject)).toContain('Staged changes');
    expect(result.reviews.map((r) => r.subject)).toContain('PR #317');
    expect(result.reviews.find((r) => r.workspaceId === 'workspace-staged')).toMatchObject({
      itemCount: 2,
      reviewedCount: 1,
      openQuestions: 0,
    });
  });

  it('returns empty list when the reviews dir is missing', async () => {
    temp = makeTempDir();
    expect(await buildReviewIndex(temp.dir)).toEqual({ reviews: [] });
  });

  it('reports a corrupt workspace as degraded without failing the whole listing', async () => {
    temp = makeTempDir();
    const store = createReviewStore(temp.dir);

    const healthy = fixture({
      workspaceId: 'workspace-healthy',
      revisionId: 'rev-1',
      source: { kind: 'unstaged', headSha: 'abc123' },
      updatedAt: '2026-08-01T10:00:00.000Z',
    });
    store.createRevision(healthy.workspace, healthy.snapshot, healthy.insights, healthy.progress);

    const corrupt = fixture({
      workspaceId: 'workspace-corrupt',
      revisionId: 'rev-1',
      source: { kind: 'unstaged', headSha: 'def456' },
      updatedAt: '2026-08-02T10:00:00.000Z',
    });
    store.createRevision(corrupt.workspace, corrupt.snapshot, corrupt.insights, corrupt.progress);
    writeFileSync(
      join(temp.dir, '.synergy', 'reviews', 'workspace-corrupt', 'workspace.json'),
      '{malformed',
      'utf8',
    );

    const result = await buildReviewIndex(temp.dir);

    expect(result.reviews).toHaveLength(2);
    const degraded = result.reviews.find((r) => r.degraded);
    expect(degraded).toBeDefined();
    expect(degraded!.workspaceId).toBe('workspace-corrupt');
    const ok = result.reviews.find((r) => r.workspaceId === 'workspace-healthy');
    expect(ok).toMatchObject({ itemCount: 1 });
    expect(ok?.degraded).toBeUndefined();
  });
});
