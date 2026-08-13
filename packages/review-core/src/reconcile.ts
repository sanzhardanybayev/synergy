import { removalRunHash } from './removal-hash.js';
import { type SnapshotRemovalRun, deriveSnapshotRemovalRuns } from './removals.js';
import type {
  RemovalRationale,
  ReviewBundle,
  ReviewFileInsight,
  ReviewInsights,
  ReviewItem,
  ReviewItemProgress,
  ReviewProgress,
  ReviewSnapshot,
} from './types.js';

export interface ReviewReconciliation extends ReviewProgress {
  /** File- and removal-level insights carried into the next revision alongside the reconciled
   * progress. */
  insights: { files?: ReviewFileInsight[]; removals?: RemovalRationale[] };
}

function isCarryable(progress: ReviewItemProgress | undefined): boolean {
  return progress?.status === 'reviewed' || progress?.status === 'carried-forward';
}

function cloneProgress(progress: ReviewItemProgress): ReviewItemProgress {
  if (!progress.inheritedFrom) return { ...progress };
  return { ...progress, inheritedFrom: { ...progress.inheritedFrom } };
}

function indexByReconciliationKey(items: ReviewItem[]): Map<string, ReviewItem[]> {
  const index = new Map<string, ReviewItem[]>();
  for (const item of items) {
    const key = reconciliationKey(item);
    const matches = index.get(key) ?? [];
    matches.push(item);
    index.set(key, matches);
  }
  return index;
}

/** Creates a stable identity for carry-forward matching independent of line offsets. */
export function reconciliationKey(item: ReviewItem): string {
  return [item.path, item.kind, item.contentHash, item.locationHash].join(':');
}

/**
 * Carries a previous file insight into the next revision only when every review item at that
 * path in the new snapshot is a carried-forward match of a previous item - a partial match
 * means the file changed underneath the insight, so it is dropped rather than left stale.
 */
function carryForwardFileInsights(
  previousInsights: ReviewInsights,
  nextSnapshot: ReviewSnapshot,
  carriedItemIds: ReadonlySet<string>,
): ReviewFileInsight[] | undefined {
  const previousFiles = previousInsights.files;
  if (!previousFiles || previousFiles.length === 0) return undefined;
  const nextItemsByPath = new Map<string, ReviewItem[]>();
  for (const item of nextSnapshot.items) {
    const list = nextItemsByPath.get(item.path) ?? [];
    list.push(item);
    nextItemsByPath.set(item.path, list);
  }
  const carried = previousFiles.filter((file) => {
    const items = nextItemsByPath.get(file.path);
    return items?.every((item) => carriedItemIds.has(item.id)) ?? false;
  });
  return carried.length > 0 ? carried : undefined;
}

/**
 * Carries a rationale into the next revision only when its review item carried forward and the
 * run's removed text is byte-identical, so a stale explanation can never outlive its code.
 */
function carryForwardRemovals(
  previousInsights: ReviewInsights,
  previousSnapshot: ReviewSnapshot,
  currentSnapshot: ReviewSnapshot,
  /** Current item id -> the previous item id it inherited from. */
  inheritance: ReadonlyMap<string, string>,
): RemovalRationale[] | undefined {
  const previousRemovals = previousInsights.removals ?? [];
  if (previousRemovals.length === 0) return undefined;

  const byItem = (runs: SnapshotRemovalRun[]): Map<string, SnapshotRemovalRun[]> => {
    const index = new Map<string, SnapshotRemovalRun[]>();
    for (const run of runs) {
      const list = index.get(run.reviewItemId) ?? [];
      list.push(run);
      index.set(run.reviewItemId, list);
    }
    return index;
  };
  const previousRuns = byItem(deriveSnapshotRemovalRuns(previousSnapshot));
  const currentRuns = byItem(deriveSnapshotRemovalRuns(currentSnapshot));

  const carried: RemovalRationale[] = [];
  for (const [currentItemId, previousItemId] of inheritance) {
    const before = previousRuns.get(previousItemId) ?? [];
    const after = currentRuns.get(currentItemId) ?? [];
    if (before.length !== after.length) continue;
    for (const [ordinal, beforeRun] of before.entries()) {
      const afterRun = after[ordinal]!;
      if (removalRunHash(beforeRun.texts) !== removalRunHash(afterRun.texts)) continue;
      const rationale = previousRemovals.find(
        (candidate) =>
          candidate.reviewItemId === previousItemId &&
          candidate.run.start === beforeRun.start &&
          candidate.run.end === beforeRun.end,
      );
      if (!rationale) continue;
      carried.push({
        ...rationale,
        reviewItemId: currentItemId,
        run: { path: afterRun.path, start: afterRun.start, end: afterRun.end },
      });
    }
  }
  return carried.length > 0 ? carried : undefined;
}

/**
 * Derives mutable progress for a new immutable snapshot without changing the prior revision.
 */
export function reconcileReview(
  previous: ReviewBundle,
  currentSnapshot: ReviewSnapshot,
  now: string,
): ReviewReconciliation {
  const previousItemsById = new Map(previous.snapshot.items.map((item) => [item.id, item]));
  const exactStateIds = new Set<string>();
  const items: Record<string, ReviewItemProgress> = {};

  for (const currentItem of currentSnapshot.items) {
    const previousItem = previousItemsById.get(currentItem.id);
    const previousState = previous.progress.items[currentItem.id];
    if (
      !previousItem ||
      !previousState ||
      reconciliationKey(previousItem) !== reconciliationKey(currentItem)
    ) {
      continue;
    }
    exactStateIds.add(currentItem.id);
    items[currentItem.id] =
      previousState.status === 'reviewed' || previousState.status === 'carried-forward'
        ? {
            status: 'carried-forward',
            inheritedFrom: {
              revisionId: previous.snapshot.revisionId,
              reviewItemId: previousItem.id,
            },
            reviewedAt: now,
          }
        : cloneProgress(previousState);
  }

  const previousCandidates = previous.snapshot.items.filter(
    (item) => !exactStateIds.has(item.id) && isCarryable(previous.progress.items[item.id]),
  );
  const currentCandidates = currentSnapshot.items.filter((item) => !exactStateIds.has(item.id));
  const previousMatches = indexByReconciliationKey(previousCandidates);
  const currentMatches = indexByReconciliationKey(currentCandidates);

  for (const currentItem of currentCandidates) {
    const key = reconciliationKey(currentItem);
    const oldMatches = previousMatches.get(key) ?? [];
    const newMatches = currentMatches.get(key) ?? [];

    if (oldMatches.length === 1 && newMatches.length === 1) {
      const priorItem = oldMatches[0]!;
      items[currentItem.id] = {
        status: 'carried-forward',
        inheritedFrom: {
          revisionId: previous.snapshot.revisionId,
          reviewItemId: priorItem.id,
        },
        reviewedAt: now,
      };
      continue;
    }

    items[currentItem.id] =
      oldMatches.length > 0 ? { status: 'stale' } : { status: 'needs-review' };
  }

  const carriedItemIds = new Set(
    Object.entries(items)
      .filter(([, itemProgress]) => itemProgress.status === 'carried-forward')
      .map(([id]) => id),
  );
  const files = carryForwardFileInsights(previous.insights, currentSnapshot, carriedItemIds);

  // Item ids are not stable across revisions - `inheritedFrom.reviewItemId` records what each
  // carried current id actually descends from, so removal rationales (keyed on the old id) can
  // be rewritten onto the new one rather than silently dropped. Content identity, not human
  // review status, is what makes a rationale still valid: `exactStateIds` (id -> itself) covers
  // the byte-identical-but-still-`needs-review` case that the common "refresh before anyone has
  // reviewed" workflow hits on every run, and the fuzzy `inheritedFrom` pointers recorded on
  // `carried-forward` entries cover items whose id changed but matched by `reconciliationKey`.
  // The correctness guard remains `reconciliationKey` (content + context) inside
  // `carryForwardRemovals` itself, so widening the inheritance source here cannot admit a
  // rationale whose underlying text changed.
  const inheritance = new Map<string, string>();
  for (const id of exactStateIds) {
    inheritance.set(id, id);
  }
  for (const id of carriedItemIds) {
    const inheritedFrom = items[id]?.inheritedFrom;
    if (inheritedFrom) inheritance.set(id, inheritedFrom.reviewItemId);
  }
  const removals = carryForwardRemovals(
    previous.insights,
    previous.snapshot,
    currentSnapshot,
    inheritance,
  );

  return {
    schemaVersion: 1,
    updatedAt: now,
    items,
    insights: { files, ...(removals ? { removals } : {}) },
  };
}
