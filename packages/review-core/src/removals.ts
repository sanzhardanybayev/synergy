import { resolveBrowserReviewItemContext } from './browser-context.js';
import type {
  RemovalRationale,
  ReviewDiffLineRow,
  ReviewInsights,
  ReviewItem,
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

/** Resolves one hunk item's rows, dropping any scope rows that can never appear alongside it. */
function hunkDiffRows(snapshot: ReviewSnapshot, item: ReviewItem): ReviewDiffLineRow[] {
  const context = resolveBrowserReviewItemContext(snapshot, item.id);
  return context.rows.filter((row): row is ReviewDiffLineRow => row.kind !== 'scope');
}

/** Every removal run across a captured diff snapshot's hunk items. Scope snapshots have none. */
export function deriveSnapshotRemovalRuns(snapshot: ReviewSnapshot): SnapshotRemovalRun[] {
  if (snapshot.kind !== 'diff') return [];
  const runs: SnapshotRemovalRun[] = [];
  for (const item of snapshot.items) {
    if (item.kind !== 'hunk') continue;
    for (const run of deriveRemovalRuns(hunkDiffRows(snapshot, item))) {
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
      // Only rows that were actually ADDED can back an in-review jump - a context row shares the
      // same new-side line number but was never touched, so a `movedTo` landing on one is not
      // evidence the removed code moved there. The whole target range must be covered by added
      // rows (no partial overlap): a target that only partly lands in this hunk must fall through
      // to excerpt capture below, which range-checks the full destination instead of silently
      // truncating to whatever happened to be captured.
      const addedByLine = new Map<number, string>();
      for (const row of hunkDiffRows(snapshot, item)) {
        if (row.kind === 'add' && row.newLine !== null) addedByLine.set(row.newLine, row.id);
      }
      const rowIds: string[] = [];
      let complete = true;
      for (let line = target.start; line <= target.end; line += 1) {
        const rowId = addedByLine.get(line);
        if (rowId === undefined) {
          complete = false;
          break;
        }
        rowIds.push(rowId);
      }
      if (complete && rowIds.length > 0) {
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
