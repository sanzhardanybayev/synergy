import type { ReviewDiffLineRow } from '@synergy/review-core';
import type {
  RemovalStrip as RemovalStripModel,
  ResolvedRemovalTarget,
} from '@synergy/review-core/browser';
import type { HighlightHunkRow } from '@synergy/review-core/highlight';
import { Fragment } from 'react';
import { CodeLine, useHighlightedHunk } from './HighlightedCode.js';
import { RemovalStrip } from './RemovalStrip.js';

interface DiffViewerProps {
  path: string;
  rows: ReviewDiffLineRow[];
  selectedLineIds: string[];
  onToggleLine(lineId: string): void;
  strips?: RemovalStripModel[];
  expandedRuns?: string[];
  onToggleRun?(key: string): void;
  onJump?(target: ResolvedRemovalTarget): void;
}

function runKey(strip: RemovalStripModel): string {
  return `${strip.run.start}-${strip.run.end}`;
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
export function DiffViewer({
  path,
  rows,
  selectedLineIds,
  onToggleLine,
  strips = [],
  expandedRuns = [],
  onToggleRun = () => {},
  onJump = () => {},
}: DiffViewerProps) {
  const highlighted = useHighlightedHunk(path, toHunkRows(rows));
  const stripByFirstLineId = new Map(strips.map((strip) => [strip.run.lineIds[0], strip]));
  return (
    <section className="review-code-scroll" aria-label="Diff lines">
      <div className="review-diff">
        {rows.map((row, index) => {
          const selected = selectedLineIds.includes(row.id);
          const marker = row.kind === 'add' ? '+' : row.kind === 'remove' ? '−' : ' ';
          const strip = stripByFirstLineId.get(row.id);
          const key = strip ? runKey(strip) : undefined;
          return (
            <Fragment key={row.id}>
              {strip ? (
                <RemovalStrip
                  key={`strip-${row.id}`}
                  strip={strip}
                  expanded={key !== undefined && expandedRuns.includes(key)}
                  onToggle={() => key !== undefined && onToggleRun(key)}
                  onJump={onJump}
                />
              ) : null}
              <div
                className={`review-code-row review-code-row--${row.kind}${
                  selected ? ' is-selected' : ''
                }`}
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
            </Fragment>
          );
        })}
      </div>
    </section>
  );
}
