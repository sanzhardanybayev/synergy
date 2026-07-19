import type {
  ReviewBundle,
  ReviewItem,
  ReviewItemProgress,
  ReviewProgress,
  ReviewSnapshot,
} from './types.js';

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
 * Derives mutable progress for a new immutable snapshot without changing the prior revision.
 */
export function reconcileReview(
  previous: ReviewBundle,
  currentSnapshot: ReviewSnapshot,
  now: string,
): ReviewProgress {
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

  return { schemaVersion: 1, updatedAt: now, items };
}
