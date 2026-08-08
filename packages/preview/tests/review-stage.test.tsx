import type { ReviewFileInsight, ReviewItem, ReviewItemProgress } from '@synergy/review-core';
import { render, screen } from '@testing-library/react';
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
