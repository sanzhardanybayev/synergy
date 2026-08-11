import type {
  ReviewDiffLineRow,
  ReviewItem,
  ReviewScopeLineRow,
  SourceFile,
} from '@synergy/review-core';
import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DiffViewer } from '../src/review/DiffViewer.js';
import { SourceViewer } from '../src/review/SourceViewer.js';
import { codeLineText } from './review-ui-fixtures.js';

const DIFF_ROWS: ReviewDiffLineRow[] = [
  { id: 'r0', kind: 'context', oldLine: 1, newLine: 1, text: '/*' },
  { id: 'r1', kind: 'remove', oldLine: 2, newLine: null, text: ' old note' },
  { id: 'r2', kind: 'add', oldLine: null, newLine: 2, text: ' new note' },
  { id: 'r3', kind: 'context', oldLine: 3, newLine: 3, text: ' */' },
  { id: 'r4', kind: 'context', oldLine: 4, newLine: 4, text: 'const answer = 42;' },
];

const SOURCE_FILE: SourceFile = {
  path: 'src/example.ts',
  binary: false,
  lines: [
    { number: 1, text: 'export const answer = 42;' },
    { number: 2, text: 'export const name = "synergy";' },
  ],
};

const SOURCE_ITEM: ReviewItem = {
  id: 'section-1',
  kind: 'code-section',
  path: SOURCE_FILE.path,
  label: 'answer',
  range: { start: 1, end: 2 },
  contentHash: 'c1',
  locationHash: 'l1',
};

const SOURCE_ROWS: ReviewScopeLineRow[] = [
  { id: 's1', kind: 'scope', line: 1, text: SOURCE_FILE.lines[0]!.text },
  { id: 's2', kind: 'scope', line: 2, text: SOURCE_FILE.lines[1]!.text },
];

/** Token spans carry an inline color; a plain fallback line has none. */
function tokenSpans(line: HTMLElement): HTMLElement[] {
  return [...line.querySelectorAll('span')].filter((span) => span.style.color !== '');
}

// Reset before each test rather than after: RTL's auto-cleanup unmounts later than a local
// afterEach, so mutating the attribute there would fire the theme observer on a live component.
beforeEach(() => {
  document.documentElement.dataset.theme = 'light';
});

describe('DiffViewer highlighting', () => {
  it('renders the captured text immediately, before tokens resolve', () => {
    render(
      <DiffViewer
        path="src/example.ts"
        rows={DIFF_ROWS}
        selectedLineIds={[]}
        onToggleLine={vi.fn()}
      />,
    );
    for (const row of DIFF_ROWS) {
      expect(screen.getByText(codeLineText(row.text))).toBeVisible();
    }
  });

  it('highlights each row while preserving its exact text and selection affordance', async () => {
    render(
      <DiffViewer
        path="src/example.ts"
        rows={DIFF_ROWS}
        selectedLineIds={['r2']}
        onToggleLine={vi.fn()}
      />,
    );
    await waitFor(() => {
      expect(tokenSpans(screen.getByText(codeLineText('const answer = 42;')))).not.toHaveLength(0);
    });
    for (const row of DIFF_ROWS) {
      expect(screen.getByText(codeLineText(row.text))).toBeVisible();
    }
    expect(screen.getAllByRole('button')).toHaveLength(DIFF_ROWS.length);
    expect(screen.getByRole('button', { name: /Deselect new line 2/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('keeps a removed line inside a block comment comment-colored', async () => {
    render(
      <DiffViewer
        path="src/example.ts"
        rows={DIFF_ROWS}
        selectedLineIds={[]}
        onToggleLine={vi.fn()}
      />,
    );
    await waitFor(() => {
      expect(tokenSpans(screen.getByText(codeLineText('/*')))).not.toHaveLength(0);
    });
    const commentColor = tokenSpans(screen.getByText(codeLineText('/*')))[0]!.style.color;
    const removed = tokenSpans(screen.getByText(codeLineText(' old note')));
    expect(removed).not.toHaveLength(0);
    expect(removed.every((span) => span.style.color === commentColor)).toBe(true);
  });

  it('leaves an unknown file type as plain text', async () => {
    render(
      <DiffViewer
        path="assets/logo.psd"
        rows={DIFF_ROWS}
        selectedLineIds={[]}
        onToggleLine={vi.fn()}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText(codeLineText('const answer = 42;'))).toBeVisible();
    });
    expect(tokenSpans(screen.getByText(codeLineText('const answer = 42;')))).toHaveLength(0);
  });
});

describe('SourceViewer highlighting', () => {
  it('highlights the captured file without disturbing line numbers', async () => {
    render(
      <SourceViewer
        file={SOURCE_FILE}
        item={SOURCE_ITEM}
        rows={SOURCE_ROWS}
        selectedLineIds={[]}
        onToggleLine={vi.fn()}
      />,
    );
    await waitFor(() => {
      expect(
        tokenSpans(screen.getByText(codeLineText('export const answer = 42;'))),
      ).not.toHaveLength(0);
    });
    expect(screen.getByText(codeLineText('export const name = "synergy";'))).toBeVisible();
    expect(screen.getByRole('button', { name: /source line 1/ })).toBeVisible();
    expect(screen.getByRole('button', { name: /source line 2/ })).toBeVisible();
  });

  it('re-highlights with the dark palette when the theme flips', async () => {
    render(
      <SourceViewer
        file={SOURCE_FILE}
        item={SOURCE_ITEM}
        rows={SOURCE_ROWS}
        selectedLineIds={[]}
        onToggleLine={vi.fn()}
      />,
    );
    await waitFor(() => {
      expect(
        tokenSpans(screen.getByText(codeLineText('export const answer = 42;'))),
      ).not.toHaveLength(0);
    });
    const lightColor = tokenSpans(screen.getByText(codeLineText('export const answer = 42;')))[0]!
      .style.color;

    // The observer fires on a microtask and re-tokenization resolves a task later; draining both
    // inside act() keeps the resulting state updates out of React's un-acted-update warning.
    await act(async () => {
      document.documentElement.dataset.theme = 'dark';
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const spans = tokenSpans(screen.getByText(codeLineText('export const answer = 42;')));
    expect(spans).not.toHaveLength(0);
    expect(spans[0]!.style.color).not.toBe(lightColor);
  });
});
