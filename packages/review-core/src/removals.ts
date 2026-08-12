import { resolveBrowserReviewItemContext } from './browser.js';
import type {
  RemovalRationale,
  ReviewDiffLineRow,
  ReviewInsights,
  ReviewSnapshot,
} from './types.js';

export interface RemovalRun {
  start: number;
  end: number;
  lineIds: string[];
  texts: string[];
}

export interface SnapshotRemovalRun extends RemovalRun {
  reviewItemId: string;
  path: string;
}

export type ResolvedRemovalTarget =
  | {
      kind: 'in-review';
      reviewItemId: string;
      rowIds: string[];
      path: string;
      start: number;
      end: number;
    }
  | { kind: 'excerpt'; path: string; start: number; lines: string[] }
  | { kind: 'unresolved' };

export interface RemovalStrip {
  run: RemovalRun;
  rationale?: RemovalRationale;
  target: ResolvedRemovalTarget;
}

/**
 * Groups maximal contiguous `remove` rows by old-side line number, preserving row order.
 * A non-removed row (or a break in old-line contiguity) closes the current run.
 */
export function deriveRemovalRuns(rows: readonly ReviewDiffLineRow[]): RemovalRun[] {
  const runs: RemovalRun[] = [];
  let current: RemovalRun | undefined;
  for (const row of rows) {
    if (row.kind !== 'remove' || row.oldLine === null) {
      current = undefined;
      continue;
    }
    if (current && current.end + 1 === row.oldLine) {
      current.end = row.oldLine;
      current.lineIds.push(row.id);
      current.texts.push(row.text);
      continue;
    }
    current = { start: row.oldLine, end: row.oldLine, lineIds: [row.id], texts: [row.text] };
    runs.push(current);
  }
  return runs;
}

/** Every removal run across a captured diff snapshot's hunk items. Scope snapshots have none. */
export function deriveSnapshotRemovalRuns(snapshot: ReviewSnapshot): SnapshotRemovalRun[] {
  if (snapshot.kind !== 'diff') return [];
  const runs: SnapshotRemovalRun[] = [];
  for (const item of snapshot.items) {
    if (item.kind !== 'hunk') continue;
    const context = resolveBrowserReviewItemContext(snapshot, item.id);
    const diffRows = context.rows.filter((row): row is ReviewDiffLineRow => row.kind !== 'scope');
    for (const run of deriveRemovalRuns(diffRows)) {
      runs.push({ ...run, reviewItemId: item.id, path: item.path });
    }
  }
  return runs;
}

/**
 * Resolves an authored `movedTo` reference: onto a captured review item (an in-review jump)
 * when the new-side target lands inside another hunk's rows, else onto the rationale's persisted
 * excerpt, else unresolved. Reads only the immutable snapshot and rationale - never the
 * filesystem or git.
 */
export function resolveRemovalTarget(
  snapshot: ReviewSnapshot,
  rationale: RemovalRationale,
): ResolvedRemovalTarget {
  const target = rationale.movedTo;
  if (target && snapshot.kind === 'diff') {
    for (const item of snapshot.items) {
      if (item.kind !== 'hunk' || item.path !== target.path) continue;
      const context = resolveBrowserReviewItemContext(snapshot, item.id);
      const rowIds = context.rows
        .filter(
          (row): row is ReviewDiffLineRow =>
            row.kind !== 'scope' &&
            row.newLine !== null &&
            row.newLine >= target.start &&
            row.newLine <= target.end,
        )
        .map((row) => row.id);
      if (rowIds.length > 0) {
        return {
          kind: 'in-review',
          reviewItemId: item.id,
          rowIds,
          path: target.path,
          start: target.start,
          end: target.end,
        };
      }
    }
  }
  const excerpt = rationale.movedToExcerpt;
  if (excerpt) return { kind: 'excerpt', ...excerpt };
  return { kind: 'unresolved' };
}

/** One strip per derived run, in row order, with its rationale (if any) and resolved target. */
export function buildRemovalStrips(
  rows: readonly ReviewDiffLineRow[],
  reviewItemId: string,
  snapshot: ReviewSnapshot,
  insights: Pick<ReviewInsights, 'removals'>,
): RemovalStrip[] {
  const rationales = (insights.removals ?? []).filter(
    (rationale) => rationale.reviewItemId === reviewItemId,
  );
  return deriveRemovalRuns(rows).map((run) => {
    const rationale = rationales.find(
      (candidate) => candidate.run.start === run.start && candidate.run.end === run.end,
    );
    return {
      run,
      ...(rationale ? { rationale } : {}),
      target: rationale ? resolveRemovalTarget(snapshot, rationale) : { kind: 'unresolved' },
    };
  });
}
