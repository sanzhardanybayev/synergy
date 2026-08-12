import { describe, expect, it } from 'vitest';
import {
  type DiffFile,
  type DiffHunk,
  type DiffReviewSnapshot,
  type RemovalRationale,
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

/**
 * Builds one hunk review item plus its matching `DiffFile` fixture with a single contiguous
 * removal run, wired so `resolveBrowserReviewItemContext` (which `deriveSnapshotRemovalRuns`
 * relies on) accepts the pairing: the hunk's `reviewItemId`/hashes/header/range must equal the
 * item's own fields exactly. `oldStart` and `removedTexts` are the two knobs the removal-carry
 * tests turn independently of each other and of the item's id/content/location hashes, letting a
 * single helper model both an id change and an unrelated line-number shift.
 */
function makeRemovalHunkItem(input: {
  itemId: string;
  contentHash: string;
  locationHash: string;
  path: string;
  oldStart: number;
  newStart: number;
  removedTexts: string[];
}): { item: ReviewItem; file: DiffFile } {
  const header = `@@ -${input.oldStart},${input.removedTexts.length + 2} +${input.newStart},2 @@`;
  const removedLines = input.removedTexts.map((text, index) => ({
    kind: 'remove' as const,
    text,
    oldLine: input.oldStart + 1 + index,
    newLine: null,
  }));
  const lines: DiffHunk['lines'] = [
    { kind: 'context', text: 'before', oldLine: input.oldStart, newLine: input.newStart },
    ...removedLines,
    {
      kind: 'context',
      text: 'after',
      oldLine: input.oldStart + 1 + input.removedTexts.length,
      newLine: input.newStart + 1,
    },
  ];
  const range = { start: input.newStart, end: input.newStart + 1 };
  const item: ReviewItem = {
    id: input.itemId,
    kind: 'hunk',
    path: input.path,
    label: header,
    range,
    contentHash: input.contentHash,
    locationHash: input.locationHash,
  };
  const hunk: DiffHunk = {
    reviewItemId: input.itemId,
    reviewItemContentHash: input.contentHash,
    reviewItemLocationHash: input.locationHash,
    header,
    oldStart: input.oldStart,
    oldLines: input.removedTexts.length + 2,
    newStart: input.newStart,
    newLines: 2,
    lines,
  };
  const file: DiffFile = {
    path: input.path,
    status: 'modified',
    additions: 0,
    deletions: input.removedTexts.length,
    binary: false,
    hunks: [hunk],
  };
  return { item, file };
}

function makeRemovalSnapshot(
  revisionId: string,
  entries: { item: ReviewItem; file: DiffFile }[],
): DiffReviewSnapshot {
  return {
    schemaVersion: 1,
    revisionId,
    source: SOURCE,
    fingerprint: `fingerprint-${revisionId}`,
    createdAt: NOW,
    kind: 'diff',
    files: entries.map((entry) => entry.file),
    items: entries.map((entry) => entry.item),
  };
}

function makePreviousWithRemovals(
  snapshot: DiffReviewSnapshot,
  progressItems: Record<string, ReviewItemProgress>,
  removals: RemovalRationale[],
): ReviewBundle {
  const previous = makePrevious(snapshot.items, progressItems);
  previous.snapshot = snapshot;
  previous.insights = { ...previous.insights, revisionId: snapshot.revisionId, removals };
  return previous;
}

/**
 * Builds one hunk review item with either one or two discontiguous removal runs (separated by a
 * context line), holding the item's id/content/location hash and old-side numbering fixed either
 * way - the exact-match carry-forward path only cares about those, not run topology. Used to
 * prove `carryForwardRemovals` skips an item outright when its removal-run count changed, rather
 * than guessing a pairing between mismatched run lists.
 */
function makeVariableRunHunkItem(input: {
  itemId: string;
  contentHash: string;
  locationHash: string;
  path: string;
  runCount: 1 | 2;
}): { item: ReviewItem; file: DiffFile } {
  const oldStart = 10;
  const lines: DiffHunk['lines'] =
    input.runCount === 2
      ? [
          { kind: 'context', text: 'ctxA', oldLine: 10, newLine: 10 },
          { kind: 'remove', text: 'removed-1', oldLine: 11, newLine: null },
          { kind: 'context', text: 'ctxB', oldLine: 12, newLine: 11 },
          { kind: 'remove', text: 'removed-2', oldLine: 13, newLine: null },
          { kind: 'context', text: 'ctxC', oldLine: 14, newLine: 12 },
        ]
      : [
          { kind: 'context', text: 'ctxA', oldLine: 10, newLine: 10 },
          { kind: 'remove', text: 'removed-1', oldLine: 11, newLine: null },
          { kind: 'context', text: 'ctxB', oldLine: 12, newLine: 11 },
          { kind: 'context', text: 'ctxC', oldLine: 13, newLine: 12 },
        ];
  const newStart = 10;
  const newLines = input.runCount === 2 ? 3 : 3;
  const header = `@@ -${oldStart},${lines.length} +${newStart},${newLines} @@`;
  const range = { start: newStart, end: newStart + newLines - 1 };
  const item: ReviewItem = {
    id: input.itemId,
    kind: 'hunk',
    path: input.path,
    label: header,
    range,
    contentHash: input.contentHash,
    locationHash: input.locationHash,
  };
  const hunk: DiffHunk = {
    reviewItemId: input.itemId,
    reviewItemContentHash: input.contentHash,
    reviewItemLocationHash: input.locationHash,
    header,
    oldStart,
    oldLines: lines.length,
    newStart,
    newLines,
    lines,
  };
  const file: DiffFile = {
    path: input.path,
    status: 'modified',
    additions: 0,
    deletions: input.runCount,
    binary: false,
    hunks: [hunk],
  };
  return { item, file };
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

  it('carries forward file insights when every item of the file is carried forward', () => {
    const i1 = makeItem('i1', { path: 'src/a.ts' });
    const i2 = makeItem('i2', {
      path: 'src/a.ts',
      contentHash: 'content-b',
      locationHash: 'location-b',
    });
    const i3 = makeItem('i3', {
      path: 'src/b.ts',
      contentHash: 'content-c',
      locationHash: 'location-c',
    });
    const previous = makePrevious([i1, i2], {
      i1: { status: 'reviewed', reviewedAt: '2026-07-19T10:00:00.000Z' },
      i2: { status: 'reviewed', reviewedAt: '2026-07-19T10:00:00.000Z' },
    });
    previous.insights = {
      ...previous.insights,
      files: [{ path: 'src/a.ts', description: 'Adds retry logic.', confidence: 'high' }],
    };

    const result = reconcileReview(previous, makeSnapshot('current-revision', [i1, i2, i3]), NOW);

    expect(result.insights.files).toEqual([expect.objectContaining({ path: 'src/a.ts' })]);
  });

  it('drops file insight when any item in the file changed', () => {
    const i1 = makeItem('i1', { path: 'src/a.ts' });
    const i2 = makeItem('i2', {
      path: 'src/a.ts',
      contentHash: 'content-b',
      locationHash: 'location-b',
    });
    const previous = makePrevious([i1, i2], {
      i1: { status: 'reviewed', reviewedAt: '2026-07-19T10:00:00.000Z' },
      i2: { status: 'reviewed', reviewedAt: '2026-07-19T10:00:00.000Z' },
    });
    previous.insights = {
      ...previous.insights,
      files: [{ path: 'src/a.ts', description: 'Adds retry logic.', confidence: 'high' }],
    };
    const i2Changed = makeItem('i2', {
      path: 'src/a.ts',
      contentHash: 'content-changed',
      locationHash: 'location-b',
    });

    const result = reconcileReview(
      previous,
      makeSnapshot('current-revision', [i1, i2Changed]),
      NOW,
    );

    expect(result.insights.files ?? []).toEqual([]);
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

  describe('removal rationale carry-forward', () => {
    it('carries a removal rationale when its item and run text are unchanged', () => {
      const previousEntry = makeRemovalHunkItem({
        itemId: 'item-old',
        contentHash: 'content-x',
        locationHash: 'location-x',
        path: 'src/a.ts',
        oldStart: 40,
        newStart: 40,
        removedTexts: ['foo', 'bar', 'baz'],
      });
      const rationale: RemovalRationale = {
        reviewItemId: 'item-old',
        run: { path: 'src/a.ts', start: 41, end: 43 },
        reason: 'dead-code',
        description: 'Removed unused helper.',
      };
      const previous = makePreviousWithRemovals(
        makeRemovalSnapshot('old-revision', [previousEntry]),
        { 'item-old': { status: 'reviewed', reviewedAt: '2026-07-19T10:00:00.000Z' } },
        [rationale],
      );
      const currentEntry = makeRemovalHunkItem({
        itemId: 'item-old',
        contentHash: 'content-x',
        locationHash: 'location-x',
        path: 'src/a.ts',
        oldStart: 40,
        newStart: 40,
        removedTexts: ['foo', 'bar', 'baz'],
      });

      const result = reconcileReview(
        previous,
        makeRemovalSnapshot('current-revision', [currentEntry]),
        NOW,
      );

      expect(result.insights.removals).toEqual([rationale]);
    });

    it('rewrites the rationale onto the new review item id when the owning item id changes across revisions', () => {
      // Same reconciliationKey (contentHash/locationHash), different item id: exactly the
      // fuzzy carry-forward path that changes a review item's id between revisions.
      const previousEntry = makeRemovalHunkItem({
        itemId: 'item-old',
        contentHash: 'content-x',
        locationHash: 'location-x',
        path: 'src/a.ts',
        oldStart: 40,
        newStart: 40,
        removedTexts: ['foo', 'bar', 'baz'],
      });
      const rationale: RemovalRationale = {
        reviewItemId: 'item-old',
        run: { path: 'src/a.ts', start: 41, end: 43 },
        reason: 'dead-code',
        description: 'Removed unused helper.',
      };
      const previous = makePreviousWithRemovals(
        makeRemovalSnapshot('old-revision', [previousEntry]),
        { 'item-old': { status: 'reviewed', reviewedAt: '2026-07-19T10:00:00.000Z' } },
        [rationale],
      );
      const currentEntry = makeRemovalHunkItem({
        itemId: 'item-new',
        contentHash: 'content-x',
        locationHash: 'location-x',
        path: 'src/a.ts',
        oldStart: 40,
        newStart: 40,
        removedTexts: ['foo', 'bar', 'baz'],
      });

      const result = reconcileReview(
        previous,
        makeRemovalSnapshot('current-revision', [currentEntry]),
        NOW,
      );

      expect(result.insights.removals).toEqual([{ ...rationale, reviewItemId: 'item-new' }]);
    });

    it('rewrites the rationale line numbers when an unrelated earlier edit shifts them but the removed text is identical', () => {
      // Same item id/content/location hash (exact carry-forward path) but the run's old-side
      // line numbers shift, as they would when an earlier, unrelated edit changed the file
      // above this hunk in the new revision's diff capture.
      const previousEntry = makeRemovalHunkItem({
        itemId: 'item-shift',
        contentHash: 'content-y',
        locationHash: 'location-y',
        path: 'src/a.ts',
        oldStart: 40,
        newStart: 40,
        removedTexts: ['x1', 'x2'],
      });
      const rationale: RemovalRationale = {
        reviewItemId: 'item-shift',
        run: { path: 'src/a.ts', start: 41, end: 42 },
        reason: 'dead-code',
        description: 'Removed unused helper.',
      };
      const previous = makePreviousWithRemovals(
        makeRemovalSnapshot('old-revision', [previousEntry]),
        { 'item-shift': { status: 'reviewed', reviewedAt: '2026-07-19T10:00:00.000Z' } },
        [rationale],
      );
      const currentEntry = makeRemovalHunkItem({
        itemId: 'item-shift',
        contentHash: 'content-y',
        locationHash: 'location-y',
        path: 'src/a.ts',
        oldStart: 50,
        newStart: 45,
        removedTexts: ['x1', 'x2'],
      });

      const result = reconcileReview(
        previous,
        makeRemovalSnapshot('current-revision', [currentEntry]),
        NOW,
      );

      expect(result.insights.removals).toEqual([
        { ...rationale, run: { path: 'src/a.ts', start: 51, end: 52 } },
      ]);
    });

    it('drops a removal rationale when the removed text changed', () => {
      const previousEntry = makeRemovalHunkItem({
        itemId: 'item-text',
        contentHash: 'content-z',
        locationHash: 'location-z',
        path: 'src/a.ts',
        oldStart: 40,
        newStart: 40,
        removedTexts: ['x1', 'x2'],
      });
      const rationale: RemovalRationale = {
        reviewItemId: 'item-text',
        run: { path: 'src/a.ts', start: 41, end: 42 },
        reason: 'dead-code',
        description: 'Removed unused helper.',
      };
      const previous = makePreviousWithRemovals(
        makeRemovalSnapshot('old-revision', [previousEntry]),
        { 'item-text': { status: 'reviewed', reviewedAt: '2026-07-19T10:00:00.000Z' } },
        [rationale],
      );
      const currentEntry = makeRemovalHunkItem({
        itemId: 'item-text',
        contentHash: 'content-z',
        locationHash: 'location-z',
        path: 'src/a.ts',
        oldStart: 40,
        newStart: 40,
        removedTexts: ['x1', 'x2-changed'],
      });

      const result = reconcileReview(
        previous,
        makeRemovalSnapshot('current-revision', [currentEntry]),
        NOW,
      );

      expect(result.insights.removals ?? []).toEqual([]);
    });

    it('drops a removal rationale whose review item did not carry forward', () => {
      const previousEntry = makeRemovalHunkItem({
        itemId: 'item-gone',
        contentHash: 'content-w',
        locationHash: 'location-w',
        path: 'src/a.ts',
        oldStart: 40,
        newStart: 40,
        removedTexts: ['x1', 'x2'],
      });
      const rationale: RemovalRationale = {
        reviewItemId: 'item-gone',
        run: { path: 'src/a.ts', start: 41, end: 42 },
        reason: 'dead-code',
        description: 'Removed unused helper.',
      };
      const previous = makePreviousWithRemovals(
        makeRemovalSnapshot('old-revision', [previousEntry]),
        { 'item-gone': { status: 'reviewed', reviewedAt: '2026-07-19T10:00:00.000Z' } },
        [rationale],
      );
      const unrelatedEntry = makeRemovalHunkItem({
        itemId: 'item-unrelated',
        contentHash: 'content-unrelated',
        locationHash: 'location-unrelated',
        path: 'src/b.ts',
        oldStart: 10,
        newStart: 10,
        removedTexts: ['y1'],
      });

      const result = reconcileReview(
        previous,
        makeRemovalSnapshot('current-revision', [unrelatedEntry]),
        NOW,
      );

      expect(result.insights.removals ?? []).toEqual([]);
    });

    it('drops all removal rationales for an item whose removal-run count changed, rather than guessing a pairing', () => {
      const previousEntry = makeVariableRunHunkItem({
        itemId: 'item-recount',
        contentHash: 'content-r',
        locationHash: 'location-r',
        path: 'src/a.ts',
        runCount: 2,
      });
      const rationales: RemovalRationale[] = [
        {
          reviewItemId: 'item-recount',
          run: { path: 'src/a.ts', start: 11, end: 11 },
          reason: 'dead-code',
          description: 'First removed block.',
        },
        {
          reviewItemId: 'item-recount',
          run: { path: 'src/a.ts', start: 13, end: 13 },
          reason: 'dead-code',
          description: 'Second removed block.',
        },
      ];
      const previous = makePreviousWithRemovals(
        makeRemovalSnapshot('old-revision', [previousEntry]),
        { 'item-recount': { status: 'reviewed', reviewedAt: '2026-07-19T10:00:00.000Z' } },
        rationales,
      );
      const currentEntry = makeVariableRunHunkItem({
        itemId: 'item-recount',
        contentHash: 'content-r',
        locationHash: 'location-r',
        path: 'src/a.ts',
        runCount: 1,
      });

      const result = reconcileReview(
        previous,
        makeRemovalSnapshot('current-revision', [currentEntry]),
        NOW,
      );

      // Same item id/content/location hash (so it does carry forward as a review item), but the
      // new hunk derives one removal run where the old one derived two: `carryForwardRemovals`
      // must not guess which old rationale (if either) pairs with the surviving run, so it drops
      // both rather than carrying a possibly-mismatched one.
      expect(result.items['item-recount']?.status).toBe('carried-forward');
      expect(result.insights.removals ?? []).toEqual([]);
    });
  });
});
