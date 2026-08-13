import {
  type ReviewFileInsight,
  type ReviewItem,
  type ReviewItemProgress,
  buildDiffSnapshot,
  deriveSnapshotRemovalRuns,
} from '@synergy/review-core';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { HunkTabs } from '../src/review/HunkTabs.js';
import { ReviewSidebar } from '../src/review/ReviewSidebar.js';
import { ReviewStage } from '../src/review/ReviewStage.js';
import { makeDiffBundle } from './review-ui-fixtures.js';

const ITEM_ONE: ReviewItem = {
  id: 'hunk-1',
  kind: 'hunk',
  path: 'a.ts',
  label: '@@ -1,1 +1,1 @@',
  range: { start: 1, end: 1 },
  contentHash: 'c1',
  locationHash: 'l1',
};

const ITEM_TWO: ReviewItem = {
  id: 'hunk-2',
  kind: 'hunk',
  path: 'a.ts',
  label: '@@ -2,1 +2,1 @@',
  range: { start: 2, end: 2 },
  contentHash: 'c2',
  locationHash: 'l2',
};

describe('HunkTabs', () => {
  it('renders one tab per hunk with reviewed state', () => {
    const progress: Record<string, ReviewItemProgress> = {
      [ITEM_TWO.id]: { status: 'reviewed' },
    };
    render(
      <HunkTabs
        items={[ITEM_ONE, ITEM_TWO]}
        activeItemId={ITEM_ONE.id}
        progress={progress}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getAllByRole('tab')).toHaveLength(2);
    expect(screen.getByRole('tab', { name: /hunk 2/i })).toHaveAttribute('data-reviewed', 'true');
    expect(screen.getByRole('tab', { name: /hunk 1/i })).toHaveAttribute('data-reviewed', 'false');
    expect(screen.getByRole('tab', { name: /hunk 1/i })).toHaveAttribute('aria-selected', 'true');
  });

  it('invokes onSelect with the tapped item id', async () => {
    const onSelect = vi.fn();
    render(
      <HunkTabs
        items={[ITEM_ONE, ITEM_TWO]}
        activeItemId={ITEM_ONE.id}
        progress={{}}
        onSelect={onSelect}
      />,
    );
    screen.getByRole('tab', { name: /hunk 2/i }).click();
    expect(onSelect).toHaveBeenCalledWith(ITEM_TWO.id);
  });
});

describe('ReviewStage', () => {
  const fileInsight: ReviewFileInsight = {
    path: 'features/plan/PlanCardToggle.tsx',
    description: 'Swaps the toggle to the primary surface token.',
    confidence: 'high',
  };

  function renderStage(overrides: Partial<Parameters<typeof ReviewStage>[0]> = {}) {
    const bundle = makeDiffBundle();
    const item = bundle.snapshot.items[0]!;
    render(
      <ReviewStage
        bundle={bundle}
        item={item}
        fileItems={[item]}
        saving={false}
        selectedLineIds={[]}
        walkthrough={{
          enabled: false,
          chapters: [],
          revealedCount: 0,
          revealAll: false,
          advanceTo: vi.fn(),
          setRevealAll: vi.fn(),
        }}
        jump={{
          origin: null,
          flashedRowIds: [],
          jumpTo: vi.fn(),
          clearOrigin: vi.fn(),
        }}
        onToggleLine={vi.fn()}
        onNoteChange={vi.fn()}
        onSaveNote={vi.fn()}
        onSetProgress={vi.fn()}
        onSelectItem={vi.fn()}
        {...overrides}
      />,
    );
  }

  it('shows file description above tabs when present', () => {
    renderStage({ fileInsight });
    expect(screen.getByText('What changed in this file')).toBeVisible();
    expect(screen.getByText('Swaps the toggle to the primary surface token.')).toBeVisible();
    expect(screen.getByRole('tablist')).toBeVisible();
  });

  it('renders without file description for legacy bundles', () => {
    expect(() => renderStage({ fileInsight: undefined })).not.toThrow();
    expect(screen.queryByText('What changed in this file')).not.toBeInTheDocument();
  });
});

describe('ReviewStage removal-rationale rendering', () => {
  // ReviewStage never reads `workspace.analysisPolicy` - it gates purely on whether a run's
  // insights carry a rationale (see the equivalent note on the VS Code pane's
  // `renderDiffLines gates removal strips on insights, not on workspace.analysisPolicy`). These
  // tests exercise that insights-driven behavior directly rather than varying `analysisPolicy`,
  // which would only look like it was testing the policy.
  const RATIONALE = {
    reviewItemId: 'hunk-theme',
    run: { path: 'features/plan/PlanCardToggle.tsx', start: 17, end: 17 },
    reason: 'dead-code' as const,
    description: 'Stale background token, superseded by the primary surface color.',
  };

  function renderStageWithBundle(bundle: ReturnType<typeof makeDiffBundle>) {
    const item = bundle.snapshot.items[0]!;
    render(
      <ReviewStage
        bundle={bundle}
        item={item}
        fileItems={[item]}
        saving={false}
        selectedLineIds={[]}
        walkthrough={{
          enabled: false,
          chapters: [],
          revealedCount: 0,
          revealAll: false,
          advanceTo: vi.fn(),
          setRevealAll: vi.fn(),
        }}
        jump={{
          origin: null,
          flashedRowIds: [],
          jumpTo: vi.fn(),
          clearOrigin: vi.fn(),
        }}
        onToggleLine={vi.fn()}
        onNoteChange={vi.fn()}
        onSaveNote={vi.fn()}
        onSetProgress={vi.fn()}
        onSelectItem={vi.fn()}
      />,
    );
  }

  it('renders no strip and no expand-all control when there is no rationale', () => {
    const bundle = makeDiffBundle();
    renderStageWithBundle(bundle);
    expect(document.querySelector('.review-removal')).toBeNull();
    expect(screen.queryByRole('button', { name: /expand all/i })).toBeNull();
  });

  it.each([true, false])(
    'renders a rationale regardless of workspace.analysisPolicy.explainRemovals (%s)',
    (explainRemovals) => {
      const base = makeDiffBundle();
      const bundle = makeDiffBundle({
        workspace: { ...base.workspace, analysisPolicy: { explainRemovals } },
        insights: { ...base.insights, removals: [RATIONALE] },
      });
      renderStageWithBundle(bundle);
      expect(screen.getByText('dead-code')).toBeTruthy();
      expect(screen.getByRole('button', { name: /expand all/i })).toBeTruthy();
    },
  );

  /**
   * The state a partially-explained review lands in after the policy is turned off mid-review:
   * one removal run carries a rationale (e.g. authored while the policy was on, or carried
   * forward from a predecessor revision), the other never got one. "Expand all" must only ever
   * claim the runs it can actually expand - see the `explainableStripKeys` comment in
   * `ReviewStage` - so this asserts the real behavior rather than trusting the button's label.
   */
  function makeMixedRemovalBundle() {
    const base = makeDiffBundle();
    const snapshot = buildDiffSnapshot({
      revisionId: 'mixed-removal-revision',
      source: base.snapshot.source,
      fingerprint: 'mixed-removal-fingerprint',
      createdAt: base.snapshot.createdAt,
      patch: [
        'diff --git a/features/plan/PlanCardToggle.tsx b/features/plan/PlanCardToggle.tsx',
        '--- a/features/plan/PlanCardToggle.tsx',
        '+++ b/features/plan/PlanCardToggle.tsx',
        '@@ -1,5 +1,3 @@',
        ' const Card = () => {',
        '-  const legacyStyle = oldTheme;',
        '   return (',
        '-    <View style={legacyStyle} />',
        '   );',
      ].join('\n'),
    });
    const item = snapshot.items[0];
    if (!item) throw new Error('fixture must produce one review item');
    return {
      ...base,
      snapshot,
      insights: {
        schemaVersion: 1 as const,
        revisionId: snapshot.revisionId,
        groups: [{ id: 'cleanup', label: 'Cleanup', reviewItemIds: [item.id] }],
        items: [
          {
            reviewItemId: item.id,
            description:
              'Drops the legacy theme style now that the card uses the primary surface token.',
            confidence: 'high' as const,
            evidencePaths: [item.path],
          },
        ],
        // Only the first run (the legacy style variable) has a rationale; the second
        // (the View's style prop) is bare - the mixed state.
        removals: [
          {
            reviewItemId: item.id,
            run: { path: item.path, start: 2, end: 2 },
            reason: 'dead-code' as const,
            description: 'Stale legacy theme variable, superseded by the primary surface token.',
          },
        ],
      },
      progress: {
        schemaVersion: 1 as const,
        updatedAt: base.progress.updatedAt,
        items: { [item.id]: { status: 'needs-review' as const } },
      },
    };
  }

  it('expands only the rationale-covered run in a mixed set, even though the control says "all"', () => {
    const bundle = makeMixedRemovalBundle();

    // Pin the fixture's premise: the diff must actually derive TWO removal runs, only one of
    // which carries a rationale. Otherwise a run-derivation regression that collapsed both
    // removed lines into a single run would still pass every assertion below.
    expect(deriveSnapshotRemovalRuns(bundle.snapshot)).toHaveLength(2);

    renderStageWithBundle(bundle);

    // The bare run renders no chrome at all - only the covered run produces a strip.
    expect(document.querySelectorAll('.review-removal')).toHaveLength(1);

    const expandAll = screen.getByRole('button', { name: /expand all/i });
    fireEvent.click(expandAll);

    expect(document.querySelectorAll('.review-removal__detail')).toHaveLength(1);
    expect(screen.getByText(/Stale legacy theme variable/)).toBeVisible();
    expect(expandAll).toHaveTextContent(/collapse all/i);
  });
});

describe('ReviewSidebar', () => {
  it('shows files with reviewed counts and no per-item rows', () => {
    const bundle = makeDiffBundle();
    render(
      <ReviewSidebar
        groups={bundle.insights.groups}
        items={bundle.snapshot.items}
        progress={{
          'hunk-theme': { status: 'reviewed' },
          'hunk-sheet': { status: 'needs-review' },
        }}
        activeItemId="hunk-theme"
        onSelectItem={vi.fn()}
        onSetProgress={vi.fn()}
      />,
    );
    expect(screen.getByText('features/plan/PlanCardToggle.tsx')).toBeVisible();
    expect(screen.getByText('1/1')).toBeVisible();
    expect(screen.queryAllByRole('listitem')).toHaveLength(0);
    expect(screen.queryByRole('button', { name: '@@ -17,1 +17,1 @@' })).not.toBeInTheDocument();
  });

  it('selects the file row and jumps to its first unreviewed item', async () => {
    const bundle = makeDiffBundle();
    const onSelectItem = vi.fn();
    render(
      <ReviewSidebar
        groups={bundle.insights.groups}
        items={bundle.snapshot.items}
        progress={{
          'hunk-theme': { status: 'needs-review' },
          'hunk-sheet': { status: 'needs-review' },
        }}
        activeItemId="hunk-theme"
        onSelectItem={onSelectItem}
        onSetProgress={vi.fn()}
      />,
    );
    screen.getByRole('button', { name: /features\/track-meal\/EditBottomSheet\.tsx/ }).click();
    expect(onSelectItem).toHaveBeenCalledWith('hunk-sheet');
  });
});
