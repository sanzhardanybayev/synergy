/** Browser-safe stable row ID shared by review-core persistence and preview selection. */
export function reviewRowId(itemId: string, position: number): string {
  if (!Number.isSafeInteger(position) || position < 0) {
    throw new Error('review row position must be a non-negative safe integer');
  }
  return `row-${encodeURIComponent(itemId)}-${position}`;
}
