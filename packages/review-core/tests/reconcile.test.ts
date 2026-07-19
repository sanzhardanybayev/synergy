import { describe, expect, it } from 'vitest';
import {
  type ReviewBundle,
  type ReviewItem,
  type ReviewItemProgress,
  type ReviewSnapshot,
  buildDiffSnapshot,
  reconcileReview,
} from '../src/index.js';

const NOW = '2026-07-19T12:00:00.000Z';
const SOURCE = { kind: 'staged' as const, headSha: 'abc1234' };

function makeItem(id: string, overrides: Partial<ReviewItem> = {}): ReviewItem {
  return {
    id,
    kind: 'hunk',
    path: 'src/example.ts',
    label: '@@ -1 +1 @@',
    range: { start: 1, end: 1 },
    contentHash: 'content-a',
    locationHash: 'location-a',
    ...overrides,
  };
}

function makeSnapshot(revisionId: string, items: ReviewItem[]): ReviewSnapshot {
  return {
    schemaVersion: 1,
    revisionId,
    source: SOURCE,
    fingerprint: `fingerprint-${revisionId}`,
    createdAt: NOW,
    kind: 'diff',
    files: [],
    items,
  };
}

function makePrevious(
  items: ReviewItem[],
  progressItems: Record<string, ReviewItemProgress>,
): ReviewBundle {
  return {
    workspace: {
      schemaVersion: 1,
      id: 'mobile-app-staged',
      repository: { root: '/workspace/mobile-app', name: 'mobile-app' },
      source: SOURCE,
      currentRevisionId: 'old-revision',
      createdAt: NOW,
      updatedAt: NOW,
    },
    snapshot: makeSnapshot('old-revision', items),
    insights: { schemaVersion: 1, revisionId: 'old-revision', groups: [], items: [] },
    progress: { schemaVersion: 1, updatedAt: NOW, items: progressItems },
    questions: [],
    answers: [],
    sourceChanged: false,
  };
}

describe('review reconciliation', () => {
  it('records exact reviewed items as carried into the new revision', () => {
    const reviewed = makeItem('exact-reviewed');
    const carried = makeItem('exact-carried', {
      contentHash: 'content-b',
      locationHash: 'location-b',
    });
    const previous = makePrevious([reviewed, carried], {
      'exact-reviewed': { status: 'reviewed', reviewedAt: '2026-07-19T10:00:00.000Z' },
      'exact-carried': {
        status: 'carried-forward',
        inheritedFrom: { revisionId: 'first-revision', reviewItemId: 'original-item' },
        reviewedAt: '2026-07-19T11:00:00.000Z',
      },
    });

    const result = reconcileReview(
      previous,
      makeSnapshot('current-revision', [reviewed, carried]),
      NOW,
    );

    expect(result.items).toEqual({
      'exact-reviewed': {
        status: 'carried-forward',
        inheritedFrom: { revisionId: 'old-revision', reviewItemId: 'exact-reviewed' },
        reviewedAt: NOW,
      },
      'exact-carried': {
        status: 'carried-forward',
        inheritedFrom: { revisionId: 'old-revision', reviewItemId: 'exact-carried' },
        reviewedAt: NOW,
      },
    });
    expect(result.updatedAt).toBe(NOW);
  });

  it('carries reviewed content only when content and location are unique matches', () => {
    const oldItem = makeItem('hunk-old', { range: { start: 1, end: 1 } });
    const shiftedItem = makeItem('hunk-current', { range: { start: 101, end: 101 } });
    const previous = makePrevious([oldItem], {
      'hunk-old': { status: 'reviewed', reviewedAt: '2026-07-19T10:00:00.000Z' },
    });

    const result = reconcileReview(previous, makeSnapshot('current-revision', [shiftedItem]), NOW);

    expect(result.items['hunk-current']).toEqual({
      status: 'carried-forward',
      inheritedFrom: { revisionId: 'old-revision', reviewItemId: 'hunk-old' },
      reviewedAt: NOW,
    });
  });

  it.each([
    ['reviewed', 'selected content', { contentHash: 'changed-content' }],
    ['carried-forward', 'selected content', { contentHash: 'changed-content' }],
    ['reviewed', 'semantic location', { locationHash: 'changed-location' }],
    ['carried-forward', 'semantic location', { locationHash: 'changed-location' }],
    ['reviewed', 'repository path', { path: 'src/moved.ts' }],
    ['carried-forward', 'repository path', { path: 'src/moved.ts' }],
    ['reviewed', 'item kind', { kind: 'hunk' as const }],
    ['carried-forward', 'item kind', { kind: 'hunk' as const }],
  ] as const)(
    'does not carry %s coverage when an exact item id has changed %s',
    (status, _change, currentOverrides) => {
      const previousItem = makeItem('stable-section-id', { kind: 'code-section' });
      const currentItem = makeItem('stable-section-id', {
        kind: 'code-section',
        ...currentOverrides,
      });
      const previous = makePrevious([previousItem], {
        [previousItem.id]: { status, reviewedAt: '2026-07-19T10:00:00.000Z' },
      });

      const result = reconcileReview(
        previous,
        makeSnapshot('current-revision', [currentItem]),
        NOW,
      );

      expect(result.items[currentItem.id]).toEqual({ status: 'needs-review' });
    },
  );

  it.each(['needs-review', 'stale'] as const)(
    'preserves exact unchanged %s state without claiming coverage',
    (status) => {
      const item = makeItem('exact-uncovered');
      const previous = makePrevious([item], { [item.id]: { status } });

      const result = reconcileReview(previous, makeSnapshot('current-revision', [item]), NOW);

      expect(result.items[item.id]).toEqual({ status });
    },
  );

  it.each([
    ['content changed', makeItem('changed-content', { contentHash: 'content-b' })],
    ['semantic location changed', makeItem('changed-location', { locationHash: 'location-b' })],
    [
      'unmatched new item',
      makeItem('new-item', { contentHash: 'content-c', locationHash: 'location-c' }),
    ],
  ])('marks %s items as needing review', (_name, item) => {
    const previous = makePrevious([makeItem('hunk-old')], {
      'hunk-old': { status: 'reviewed', reviewedAt: '2026-07-19T10:00:00.000Z' },
    });

    const result = reconcileReview(previous, makeSnapshot('current-revision', [item]), NOW);

    expect(result.items).toEqual({ [item.id]: { status: 'needs-review' } });
  });

  it('marks every ambiguous duplicate candidate stale instead of guessing coverage', () => {
    const oldFirst = makeItem('old-first');
    const oldSecond = makeItem('old-second');
    const currentFirst = makeItem('current-first');
    const currentSecond = makeItem('current-second');
    const previous = makePrevious([oldFirst, oldSecond], {
      'old-first': { status: 'reviewed', reviewedAt: '2026-07-19T10:00:00.000Z' },
      'old-second': { status: 'carried-forward', reviewedAt: '2026-07-19T11:00:00.000Z' },
    });

    const result = reconcileReview(
      previous,
      makeSnapshot('current-revision', [currentFirst, currentSecond]),
      NOW,
    );

    expect(result.items).toEqual({
      'current-first': { status: 'stale' },
      'current-second': { status: 'stale' },
    });
  });

  it('does not carry coverage when repeated semantic hunks move together', () => {
    const repeatedPatch = (firstStart: number, secondStart: number): string =>
      [
        'diff --git a/src/repeated.ts b/src/repeated.ts',
        '--- a/src/repeated.ts',
        '+++ b/src/repeated.ts',
        `@@ -${firstStart} +${firstStart} @@`,
        '-before',
        '+after',
        `@@ -${secondStart} +${secondStart} @@`,
        '-before',
        '+after',
      ].join('\n');
    const previousSnapshot = buildDiffSnapshot({
      revisionId: 'old-revision',
      source: SOURCE,
      fingerprint: 'fingerprint-old',
      createdAt: NOW,
      patch: repeatedPatch(1, 11),
    });
    const currentSnapshot = buildDiffSnapshot({
      revisionId: 'current-revision',
      source: SOURCE,
      fingerprint: 'fingerprint-current',
      createdAt: NOW,
      patch: repeatedPatch(101, 111),
    });
    const previous = makePrevious(
      previousSnapshot.items,
      Object.fromEntries(
        previousSnapshot.items.map((item) => [
          item.id,
          { status: 'reviewed' as const, reviewedAt: NOW },
        ]),
      ),
    );

    const result = reconcileReview(previous, currentSnapshot, NOW);

    const previousIds = new Set(previousSnapshot.items.map((item) => item.id));
    expect(currentSnapshot.items.some((item) => previousIds.has(item.id))).toBe(false);
    expect(Object.values(result.items)).toEqual([{ status: 'stale' }, { status: 'stale' }]);
  });

  it('does not carry coverage across changed binary patch bytes at the same path', () => {
    const binarySnapshot = (revisionId: string, nextBlob: string) =>
      buildDiffSnapshot({
        revisionId,
        source: SOURCE,
        fingerprint: `fingerprint-${revisionId}`,
        createdAt: NOW,
        patch: [
          'diff --git a/assets/logo.png b/assets/logo.png',
          `index 1111111..${nextBlob} 100644`,
          'Binary files a/assets/logo.png and b/assets/logo.png differ',
        ].join('\n'),
      });
    const previousSnapshot = binarySnapshot('old-revision', '2222222');
    const changedSnapshot = binarySnapshot('changed-revision', '3333333');
    const unchangedSnapshot = binarySnapshot('unchanged-revision', '2222222');
    const previousItem = previousSnapshot.items[0]!;
    const previous = makePrevious(previousSnapshot.items, {
      [previousItem.id]: { status: 'reviewed', reviewedAt: NOW },
    });

    expect(reconcileReview(previous, changedSnapshot, NOW).items).toEqual({
      [changedSnapshot.items[0]!.id]: { status: 'needs-review' },
    });
    expect(reconcileReview(previous, unchangedSnapshot, NOW).items).toEqual({
      [unchangedSnapshot.items[0]!.id]: {
        status: 'carried-forward',
        inheritedFrom: { revisionId: 'old-revision', reviewItemId: previousItem.id },
        reviewedAt: NOW,
      },
    });
  });

  it('does not carry coverage when the final-newline marker moves between changed lines', () => {
    const newlineSnapshot = (revisionId: string, markerAfter: 'remove' | 'add') =>
      buildDiffSnapshot({
        revisionId,
        source: SOURCE,
        fingerprint: `fingerprint-${revisionId}`,
        createdAt: NOW,
        patch: [
          'diff --git a/src/example.ts b/src/example.ts',
          '--- a/src/example.ts',
          '+++ b/src/example.ts',
          '@@ -1 +1 @@',
          '-before',
          ...(markerAfter === 'remove' ? ['\\ No newline at end of file'] : []),
          '+after',
          ...(markerAfter === 'add' ? ['\\ No newline at end of file'] : []),
        ].join('\n'),
      });
    const previousSnapshot = newlineSnapshot('old-revision', 'remove');
    const currentSnapshot = newlineSnapshot('current-revision', 'add');
    const previousItem = previousSnapshot.items[0]!;
    const previous = makePrevious(previousSnapshot.items, {
      [previousItem.id]: { status: 'reviewed', reviewedAt: NOW },
    });

    expect(reconcileReview(previous, currentSnapshot, NOW).items).toEqual({
      [currentSnapshot.items[0]!.id]: { status: 'needs-review' },
    });
  });
});
