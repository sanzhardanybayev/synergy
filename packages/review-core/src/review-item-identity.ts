import type { ReviewItem } from './types.js';

/** Returns the first repeated persisted review-item identity, if one exists. */
export function findDuplicateReviewItemId(
  items: readonly Pick<ReviewItem, 'id'>[],
): string | undefined {
  const ids = new Set<string>();
  for (const item of items) {
    if (ids.has(item.id)) return item.id;
    ids.add(item.id);
  }
  return undefined;
}
