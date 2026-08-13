import type { ReviewDiffLineRow } from '@synergy/review-core';
import type { RemovalStrip as RemovalStripModel } from '@synergy/review-core/browser';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DiffViewer, runKey } from '../src/review/DiffViewer.js';

const ROWS: ReviewDiffLineRow[] = [
  { id: 'r0', kind: 'context', oldLine: 40, newLine: 40, text: 'keep0' },
  { id: 'r1', kind: 'remove', oldLine: 41, newLine: null, text: 'removed one' },
  { id: 'r2', kind: 'remove', oldLine: 42, newLine: null, text: 'removed two' },
  { id: 'r3', kind: 'context', oldLine: 43, newLine: 41, text: 'tail' },
];

function makeStrip(overrides: Partial<RemovalStripModel> = {}): RemovalStripModel {
  return {
    run: { start: 41, end: 42, lineIds: ['r1', 'r2'], texts: ['removed one', 'removed two'] },
    rationale: {
      reviewItemId: 'item-1',
      run: { path: 'a.ts', start: 41, end: 42 },
      reason: 'dead-code',
      description: 'No longer reachable.',
    },
    target: { kind: 'unresolved' },
    ...overrides,
  };
}

describe('runKey', () => {
  it('is unique per run even when two runs share the same line span', () => {
    // Two files (or two hunks in the same file) can each have a removal run at lines 41-42;
    // `expandedRuns` is a flat array that survives item switches within a revision, so the key
    // must not collide just because the start/end numbers match.
    const stripInFileA = makeStrip({
      run: { start: 41, end: 42, lineIds: ['file-a:r1', 'file-a:r2'], texts: ['a', 'b'] },
    });
    const stripInFileB = makeStrip({
      run: { start: 41, end: 42, lineIds: ['file-b:r1', 'file-b:r2'], texts: ['c', 'd'] },
    });
    expect(runKey(stripInFileA)).not.toBe(runKey(stripInFileB));
    expect(runKey(stripInFileA)).toBe('file-a:r1');
    expect(runKey(stripInFileB)).toBe('file-b:r1');
  });
});

describe('DiffViewer removal strip placement', () => {
  it("renders the strip immediately before its run's first remove row", () => {
    const strip = makeStrip();
    render(
      <DiffViewer
        path="src/a.ts"
        rows={ROWS}
        selectedLineIds={[]}
        onToggleLine={vi.fn()}
        strips={[strip]}
        expandedRuns={[]}
        onToggleRun={vi.fn()}
        onJump={vi.fn()}
      />,
    );
    const codeRows = screen
      .getByLabelText('Diff lines')
      .querySelectorAll('.review-removal, .review-code-row');
    const nodes = [...codeRows];
    const stripIndex = nodes.findIndex((node) => node.classList.contains('review-removal'));
    const firstRemoveIndex = nodes.findIndex((node) =>
      node.classList.contains('review-code-row--remove'),
    );
    expect(stripIndex).toBeGreaterThanOrEqual(0);
    expect(firstRemoveIndex).toBeGreaterThanOrEqual(0);
    expect(stripIndex).toBeLessThan(firstRemoveIndex);
    // Exactly adjacent: the strip is the element right before the first `remove` row, not merely
    // somewhere earlier in the list.
    expect(stripIndex).toBe(firstRemoveIndex - 1);
  });
});
