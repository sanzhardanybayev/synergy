import type {
  ReviewBundle,
  ReviewFileInsight,
  ReviewInsights,
  ReviewItem,
  ReviewItemProgress,
  ReviewProgress,
  ReviewSnapshot,
} from './types.js';

export interface ReviewReconciliation extends ReviewProgress {
  /** File-level insights carried into the next revision alongside the reconciled progress. */
  insights: { files?: ReviewFileInsight[] };
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

  return { schemaVersion: 1, updatedAt: now, items, insights: { files } };
}
