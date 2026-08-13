// @vitest-environment jsdom
import type {
  DiffFile,
  DiffHunk,
  DiffLine,
  DiffReviewSnapshot,
  ReviewInsights,
  ReviewItem,
} from '@synergy/review-core';
import { describe, expect, it, vi } from 'vitest';
// This is the SOURCE, not the bundled `media/panel.js` (see the file banner in panel.js) -
// `renderDiffLines`/`renderRemovalStrip` are exported specifically so the removal-strip DOM
// shape can be exercised here without a real VS Code webview. Importing this module also runs
// its top-level `if (typeof acquireVsCodeApi === 'function') startWebview();` guard, which stays
// a no-op under vitest/jsdom because `acquireVsCodeApi` is never defined there.
import {
  excludeSummary,
  renderDiffLines,
  renderRemovalStrip,
  renderRemovalSummary,
} from './panel.js';

function diffLine(
  kind: DiffLine['kind'],
  text: string,
  oldLine: number | null,
  newLine: number | null,
): DiffLine {
  return { kind, text, oldLine, newLine };
}

/** A hunk with two removal runs (old lines 2-4, and old line 6) inside a 5-new-line hunk. */
function twoRunsHunk(): DiffHunk {
  return {
    reviewItemId: 'item-1',
    reviewItemContentHash: 'hash-1',
    reviewItemLocationHash: 'loc-1',
    header: '@@ -1,9 +1,5 @@',
    oldStart: 1,
    oldLines: 9,
    newStart: 1,
    newLines: 5,
    lines: [
      diffLine('context', 'L1', 1, 1),
      diffLine('remove', 'R1', 2, null),
      diffLine('remove', 'R2', 3, null),
      diffLine('remove', 'R3', 4, null),
      diffLine('context', 'L2', 5, 2),
      diffLine('remove', 'R4', 6, null),
      diffLine('context', 'L3', 7, 3),
      diffLine('context', 'L4', 8, 4),
      diffLine('context', 'L5', 9, 5),
    ],
  };
}

function twoRunsItem(): ReviewItem {
  return {
    id: 'item-1',
    kind: 'hunk',
    path: 'src/a.ts',
    label: '@@ -1,9 +1,5 @@',
    range: { start: 1, end: 5 },
    contentHash: 'hash-1',
    locationHash: 'loc-1',
  };
}

function snapshotFor(items: ReviewItem[], files: DiffFile[]): DiffReviewSnapshot {
  return {
    schemaVersion: 1,
    revisionId: 'rev-1',
    source: { kind: 'staged', headSha: 'a' },
    fingerprint: 'fp',
    createdAt: '2026-01-01T00:00:00.000Z',
    kind: 'diff',
    files,
    items,
  };
}

function fileFor(hunk: DiffHunk): DiffFile {
  return {
    path: 'src/a.ts',
    status: 'modified',
    additions: 0,
    deletions: 4,
    binary: false,
    hunks: [hunk],
  };
}

describe('renderDiffLines removal strips', () => {
  it('renders one removal strip per run, with its category badge and run size', () => {
    const hunk = twoRunsHunk();
    const insights: Pick<ReviewInsights, 'removals'> = {
      removals: [
        {
          reviewItemId: 'item-1',
          run: { path: 'src/a.ts', start: 2, end: 4 },
          reason: 'moved',
          description: 'Moved into the interceptor.',
        },
        {
          reviewItemId: 'item-1',
          run: { path: 'src/a.ts', start: 6, end: 6 },
          reason: 'dead-code',
          description: 'Unreachable debug line.',
        },
      ],
    };
    const container = renderDiffLines(hunk, 'src/a.ts', {
      reviewItemId: 'item-1',
      snapshot: snapshotFor([twoRunsItem()], [fileFor(hunk)]),
      insights,
      onJumpToReviewItem: () => {},
      onOpenFile: () => {},
    });

    const strips = container.querySelectorAll('.removal-strip');
    expect(strips).toHaveLength(2);
    expect(strips[0]?.textContent).toContain('moved');
    expect(strips[0]?.textContent).toContain('3 lines removed');
    expect(strips[1]?.textContent).toContain('dead-code');
    expect(strips[1]?.textContent).toContain('1 line removed');
  });

  it('renders an open-in-editor action for a run whose target excerpt is outside the review', () => {
    const hunk: DiffHunk = {
      reviewItemId: 'item-2',
      reviewItemContentHash: 'hash-2',
      reviewItemLocationHash: 'loc-2',
      header: '@@ -1,2 +1,1 @@',
      oldStart: 1,
      oldLines: 2,
      newStart: 1,
      newLines: 1,
      lines: [diffLine('remove', 'stale line', 1, null), diffLine('context', 'kept', 2, 1)],
    };
    const item: ReviewItem = {
      id: 'item-2',
      kind: 'hunk',
      path: 'src/a.ts',
      label: '@@ -1,2 +1,1 @@',
      range: { start: 1, end: 1 },
      contentHash: 'hash-2',
      locationHash: 'loc-2',
    };
    const insights: Pick<ReviewInsights, 'removals'> = {
      removals: [
        {
          reviewItemId: 'item-2',
          run: { path: 'src/a.ts', start: 1, end: 1 },
          reason: 'moved',
          description: 'Moved to the shared helper.',
          movedToExcerpt: { path: 'src/b.ts', start: 88, lines: ['if (x) {', '}'] },
        },
      ],
    };

    const container = renderDiffLines(hunk, 'src/a.ts', {
      reviewItemId: 'item-2',
      snapshot: snapshotFor([item], [fileFor(hunk)]),
      insights,
      onJumpToReviewItem: () => {},
      onOpenFile: () => {},
    });

    const openButton = container.querySelector('[data-open-path="src/b.ts"]');
    expect(openButton).not.toBeNull();
    expect(openButton?.getAttribute('data-open-line')).toBe('88');
    expect(container.textContent).toContain('if (x) {');
  });

  it('renders nothing extra for a removal run with no authored rationale', () => {
    const hunk = twoRunsHunk();
    const container = renderDiffLines(hunk, 'src/a.ts', {
      reviewItemId: 'item-1',
      snapshot: snapshotFor([twoRunsItem()], [fileFor(hunk)]),
      insights: { removals: [] },
      onJumpToReviewItem: () => {},
      onOpenFile: () => {},
    });
    expect(container.querySelectorAll('.removal-strip')).toHaveLength(0);
  });

  it('renders the plain diff with no removal strips when no context is passed', () => {
    const hunk = twoRunsHunk();
    const container = renderDiffLines(hunk, 'src/a.ts');
    expect(container.querySelectorAll('.removal-strip')).toHaveLength(0);
    expect(container.querySelectorAll('.diff-line')).toHaveLength(hunk.lines.length);
  });
});

describe('renderDiffLines respects the opt-in removal-rationale policy', () => {
  // `renderDiffLines`/`renderRemovalStrip` never read `workspace.analysisPolicy` themselves -
  // they gate purely on whether a run's insights carry a rationale, which is what makes "policy
  // off" and "policy on" both render correctly with the same code path: with the policy off the
  // agent simply never authors a rationale into `insights.removals`, so every run in that state
  // naturally falls into the "no rationale" case below.
  it('renders no strip when the policy is off and no rationale was authored', () => {
    const hunk = twoRunsHunk();
    const container = renderDiffLines(hunk, 'src/a.ts', {
      reviewItemId: 'item-1',
      snapshot: snapshotFor([twoRunsItem()], [fileFor(hunk)]),
      insights: { removals: [] },
      onJumpToReviewItem: () => {},
      onOpenFile: () => {},
    });
    expect(container.querySelectorAll('.removal-strip')).toHaveLength(0);
  });

  it('still renders a rationale carried forward from a revision captured with the policy on', () => {
    const hunk = twoRunsHunk();
    const insights: Pick<ReviewInsights, 'removals'> = {
      removals: [
        {
          reviewItemId: 'item-1',
          run: { path: 'src/a.ts', start: 2, end: 4 },
          reason: 'moved',
          description: 'Moved into the interceptor.',
        },
      ],
    };
    const container = renderDiffLines(hunk, 'src/a.ts', {
      reviewItemId: 'item-1',
      snapshot: snapshotFor([twoRunsItem()], [fileFor(hunk)]),
      insights,
      onJumpToReviewItem: () => {},
      onOpenFile: () => {},
    });
    const strips = container.querySelectorAll('.removal-strip');
    expect(strips).toHaveLength(1);
    expect(strips[0]?.textContent).toContain('moved');
  });

  it('renders every covered run when the policy is on, same as before the policy existed', () => {
    const hunk = twoRunsHunk();
    const insights: Pick<ReviewInsights, 'removals'> = {
      removals: [
        {
          reviewItemId: 'item-1',
          run: { path: 'src/a.ts', start: 2, end: 4 },
          reason: 'moved',
          description: 'Moved into the interceptor.',
        },
        {
          reviewItemId: 'item-1',
          run: { path: 'src/a.ts', start: 6, end: 6 },
          reason: 'dead-code',
          description: 'Unreachable debug line.',
        },
      ],
    };
    const container = renderDiffLines(hunk, 'src/a.ts', {
      reviewItemId: 'item-1',
      snapshot: snapshotFor([twoRunsItem()], [fileFor(hunk)]),
      insights,
      onJumpToReviewItem: () => {},
      onOpenFile: () => {},
    });
    expect(container.querySelectorAll('.removal-strip')).toHaveLength(2);
  });
});

describe('renderRemovalSummary', () => {
  // Reproduces the diff-toggle-off host state: renderHunkRow calls this instead of
  // renderDiffLines when `state.diffVisible` is false, so a reviewer must still see that a
  // removal run exists and carries a rationale even with the diff body collapsed.
  it('renders the removal strips with no diff line rows', () => {
    const hunk = twoRunsHunk();
    const insights: Pick<ReviewInsights, 'removals'> = {
      removals: [
        {
          reviewItemId: 'item-1',
          run: { path: 'src/a.ts', start: 2, end: 4 },
          reason: 'moved',
          description: 'Moved into the interceptor.',
        },
      ],
    };
    const container = renderRemovalSummary({
      reviewItemId: 'item-1',
      snapshot: snapshotFor([twoRunsItem()], [fileFor(hunk)]),
      insights,
      onJumpToReviewItem: () => {},
      onOpenFile: () => {},
    });

    expect(container).not.toBeNull();
    expect(container?.querySelectorAll('.removal-strip')).toHaveLength(1);
    expect(container?.querySelectorAll('.diff-line')).toHaveLength(0);
    expect(container?.textContent).toContain('moved');
  });

  it('returns null when the item has no removal runs at all', () => {
    const hunk: DiffHunk = {
      reviewItemId: 'item-clean',
      reviewItemContentHash: 'hash-clean',
      reviewItemLocationHash: 'loc-clean',
      header: '@@ -1,1 +1,2 @@',
      oldStart: 1,
      oldLines: 1,
      newStart: 1,
      newLines: 2,
      lines: [diffLine('context', 'kept', 1, 1), diffLine('add', 'new line', null, 2)],
    };
    const item: ReviewItem = {
      id: 'item-clean',
      kind: 'hunk',
      path: 'src/a.ts',
      label: '@@ -1,1 +1,2 @@',
      range: { start: 1, end: 2 },
      contentHash: 'hash-clean',
      locationHash: 'loc-clean',
    };
    const container = renderRemovalSummary({
      reviewItemId: 'item-clean',
      snapshot: snapshotFor([item], [fileFor(hunk)]),
      insights: { removals: [] },
      onJumpToReviewItem: () => {},
      onOpenFile: () => {},
    });
    expect(container).toBeNull();
  });

  it('returns null when no context is passed', () => {
    expect(renderRemovalSummary(undefined)).toBeNull();
  });
});

describe('renderRemovalStrip', () => {
  const strip = {
    run: { start: 41, end: 43, lineIds: ['r1', 'r2', 'r3'], texts: ['a', 'b', 'c'] },
    rationale: {
      reviewItemId: 'item-1',
      run: { path: 'a.ts', start: 41, end: 43 },
      reason: 'moved' as const,
      description: 'Refresh converged into the interceptor.',
      movedTo: { path: 'b.ts', start: 88, end: 89 },
    },
    target: {
      kind: 'in-review' as const,
      reviewItemId: 'item-2',
      rowIds: ['r9'],
      path: 'b.ts',
      start: 88,
      end: 89,
    },
  };

  it('renders nothing for a run with no rationale', () => {
    expect(
      renderRemovalStrip(
        { run: strip.run, target: { kind: 'unresolved' } },
        { onJumpToReviewItem: () => {}, onOpenFile: () => {} },
      ),
    ).toBeNull();
  });

  it('keeps the rationale sentence hidden until expanded, and toggles aria-expanded', () => {
    const node = renderRemovalStrip(strip, { onJumpToReviewItem: () => {}, onOpenFile: () => {} });
    const toggle = node?.querySelector('.removal-toggle');
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    expect(node?.classList.contains('is-expanded')).toBe(false);
    // The sentence is present in the DOM either way (CSS hides it while collapsed) - clicking the
    // toggle announces the state change via aria-expanded, which is what matters for a11y.
    expect(node?.textContent).toContain('Refresh converged into the interceptor.');

    toggle?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    expect(node?.classList.contains('is-expanded')).toBe(true);
  });

  it('calls onJumpToReviewItem with the resolved target for an in-review target', () => {
    const onJumpToReviewItem = vi.fn();
    const node = renderRemovalStrip(strip, { onJumpToReviewItem, onOpenFile: () => {} });
    const jumpButton = node?.querySelector('.removal-jump');
    expect(jumpButton?.textContent).toContain('b.ts:88');
    jumpButton?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    expect(onJumpToReviewItem).toHaveBeenCalledWith('item-2');
  });

  it('renders the badge and sentence with no jump chip and no peek for an unresolved target', () => {
    const unresolvedStrip = {
      ...strip,
      target: { kind: 'unresolved' as const },
    };
    const node = renderRemovalStrip(unresolvedStrip, {
      onJumpToReviewItem: () => {},
      onOpenFile: () => {},
    });
    expect(node?.querySelector('.removal-cat')?.textContent).toBe('moved');
    expect(node?.textContent).toContain('Refresh converged into the interceptor.');
    expect(node?.querySelector('.removal-jump')).toBeNull();
    expect(node?.querySelector('.removal-peek')).toBeNull();
    expect(node?.querySelector('.removal-open-file')).toBeNull();
  });

  it('renders an unclear rationale as an unresolved, unhued badge with no jump chip', () => {
    const unclearStrip = {
      run: strip.run,
      rationale: {
        reviewItemId: 'item-1',
        run: { path: 'a.ts', start: 41, end: 43 },
        reason: 'unclear' as const,
        description: 'Removed alongside the auth refactor; could not confirm where it landed.',
      },
      target: { kind: 'unresolved' as const },
    };
    const node = renderRemovalStrip(unclearStrip, {
      onJumpToReviewItem: () => {},
      onOpenFile: () => {},
    });
    const cat = node?.querySelector('.removal-cat');
    expect(cat?.textContent).toBe('unclear');
    expect(cat?.classList.contains('removal-cat-unclear')).toBe(true);
    expect(node?.querySelector('.removal-jump')).toBeNull();
    expect(node?.textContent).toContain('could not confirm where it landed');
  });

  it('renders a peek and an open-in-editor action instead of a jump for an out-of-review target', () => {
    const onOpenFile = vi.fn();
    const excerptStrip = {
      ...strip,
      target: { kind: 'excerpt' as const, path: 'b.ts', start: 88, lines: ['if (x) {', '}'] },
    };
    const node = renderRemovalStrip(excerptStrip, { onJumpToReviewItem: () => {}, onOpenFile });
    expect(node?.querySelector('.removal-jump')).toBeNull();
    expect(node?.textContent).toContain('if (x) {');
    const openButton = node?.querySelector('[data-open-path="b.ts"]');
    expect(openButton?.getAttribute('data-open-line')).toBe('88');
    openButton?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    expect(onOpenFile).toHaveBeenCalledWith('b.ts', 88);
  });
});

describe('excludeSummary', () => {
  it('returns null when the source carries no excludes', () => {
    expect(excludeSummary({ kind: 'staged', headSha: 'a' })).toBeNull();
    expect(excludeSummary({ kind: 'staged', headSha: 'a', excludes: [] })).toBeNull();
  });

  it('joins configured excludes into a labeled summary so the reviewer sees what was dropped', () => {
    expect(excludeSummary({ kind: 'staged', headSha: 'a', excludes: ['.vouch', 'dist'] })).toBe(
      'Excluded: .vouch, dist',
    );
  });
});
