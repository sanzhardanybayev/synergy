import type { ReviewDiffLineRow } from '@synergy/review-core';
import type { HighlightHunkRow } from '@synergy/review-core/highlight';
import { CodeLine, useHighlightedHunk } from './HighlightedCode.js';

interface DiffViewerProps {
  path: string;
  rows: ReviewDiffLineRow[];
  selectedLineIds: string[];
  onToggleLine(lineId: string): void;
}

/** Diff rows carry `add`/`remove`/`context` already; the highlighter needs only kind and text. */
function toHunkRows(rows: ReviewDiffLineRow[]): HighlightHunkRow[] {
  return rows.map((row) => ({ kind: row.kind, text: row.text }));
}

function selectionLabel(row: ReviewDiffLineRow, selected: boolean): string {
  const action = selected ? 'Deselect' : 'Select';
  if (row.kind === 'add') return `${action} new line ${row.newLine ?? 'unknown'}`;
  if (row.kind === 'remove') return `${action} old line ${row.oldLine ?? 'unknown'}`;
  return `${action} old line ${row.oldLine ?? 'unknown'} and new line ${row.newLine ?? 'unknown'}`;
}

/** Renders the immutable hunk with canonical, independently selectable rows. */
export function DiffViewer({ path, rows, selectedLineIds, onToggleLine }: DiffViewerProps) {
  const highlighted = useHighlightedHunk(path, toHunkRows(rows));
  return (
    <section className="review-code-scroll" aria-label="Diff lines">
      <div className="review-diff">
        {rows.map((row, index) => {
          const selected = selectedLineIds.includes(row.id);
          const marker = row.kind === 'add' ? '+' : row.kind === 'remove' ? '−' : ' ';
          return (
            <div
              className={`review-code-row review-code-row--${row.kind}${
                selected ? ' is-selected' : ''
              }`}
              key={row.id}
            >
              <button
                type="button"
                className="review-code-row__select"
                aria-label={selectionLabel(row, selected)}
                aria-pressed={selected}
                onClick={() => onToggleLine(row.id)}
              >
                {selected ? '●' : '○'}
              </button>
              <span
                className="review-code-row__number"
                aria-label={`Old line ${row.oldLine ?? ''}`}
              >
                {row.oldLine ?? ''}
              </span>
              <span
                className="review-code-row__number"
                aria-label={`New line ${row.newLine ?? ''}`}
              >
                {row.newLine ?? ''}
              </span>
              <span className="review-code-row__marker" aria-hidden="true">
                {marker}
              </span>
              <CodeLine text={row.text} tokens={highlighted?.[index]} />
            </div>
          );
        })}
      </div>
    </section>
  );
}
