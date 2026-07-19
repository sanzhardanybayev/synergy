import { createHunkReviewItem } from './diff.js';
import { reviewRowId } from './review-row-id.js';
import type {
  DiffHunk,
  ReviewDiffLineRow,
  ReviewItem,
  ReviewItemContext,
  ReviewLineRow,
  ReviewLineSelection,
  ReviewScopeLineRow,
  ReviewSnapshot,
} from './types.js';

function sameSemanticItem(left: ReviewItem, right: ReviewItem): boolean {
  return (
    left.kind === right.kind &&
    left.path === right.path &&
    left.label === right.label &&
    left.range.start === right.range.start &&
    left.range.end === right.range.end &&
    left.contentHash === right.contentHash &&
    left.locationHash === right.locationHash
  );
}

function scopeRows(snapshot: ReviewSnapshot, item: ReviewItem): ReviewScopeLineRow[] {
  if (snapshot.kind !== 'scope' || item.kind !== 'code-section') {
    throw new Error('review item kind does not match scoped snapshot');
  }
  const file = snapshot.files.find((candidate) => candidate.path === item.path);
  if (!file || file.binary) throw new Error('review item source file is unavailable');
  const lines = file.lines.filter(
    (line) => line.number >= item.range.start && line.number <= item.range.end,
  );
  if (lines.length !== item.range.end - item.range.start + 1) {
    throw new Error('review item range is not complete in its source file');
  }
  return lines.map((line, position) => ({
    id: reviewRowId(item.id, position),
    kind: 'scope',
    line: line.number,
    text: line.text,
  }));
}

function exactHunk(snapshot: ReviewSnapshot, item: ReviewItem): DiffHunk {
  if (snapshot.kind !== 'diff' || item.kind !== 'hunk') {
    throw new Error('review item kind does not match diff snapshot');
  }
  const file = snapshot.files.find((candidate) => candidate.path === item.path);
  if (!file) throw new Error('review item diff file is unavailable');
  const matchingHunks = file.hunks.filter(
    (candidate) =>
      candidate.reviewItemId === item.id &&
      candidate.reviewItemContentHash === item.contentHash &&
      candidate.reviewItemLocationHash === item.locationHash &&
      sameSemanticItem(createHunkReviewItem(file.path, candidate), item),
  );
  if (matchingHunks.length !== 1) {
    throw new Error('review item does not match an exact immutable hunk');
  }
  return matchingHunks[0]!;
}

function diffRows(snapshot: ReviewSnapshot, item: ReviewItem): ReviewDiffLineRow[] {
  if (snapshot.kind === 'diff' && item.kind === 'file') {
    const matchingFiles = snapshot.files.filter(
      (file) =>
        file.path === item.path &&
        file.reviewItemId === item.id &&
        file.reviewItemContentHash === item.contentHash &&
        file.reviewItemLocationHash === item.locationHash,
    );
    if (matchingFiles.length !== 1) {
      throw new Error('review item does not match an exact immutable file change');
    }
    return [];
  }
  return exactHunk(snapshot, item).lines.map((line, position) => ({
    id: reviewRowId(item.id, position),
    kind: line.kind,
    oldLine: line.oldLine,
    newLine: line.newLine,
    text: line.text,
    ...(line.noNewlineAtEnd === undefined ? {} : { noNewlineAtEnd: line.noNewlineAtEnd }),
  }));
}

/** Resolves one item's complete canonical immutable line context. */
export function resolveReviewItemContext(
  snapshot: ReviewSnapshot,
  reviewItemId: string,
): ReviewItemContext {
  const matchingItems = snapshot.items.filter((candidate) => candidate.id === reviewItemId);
  if (matchingItems.length === 0) throw new Error('unknown review item');
  if (matchingItems.length !== 1) throw new Error('review item identity is ambiguous');
  const item = matchingItems[0]!;
  const rows: ReviewLineRow[] =
    snapshot.kind === 'scope' ? scopeRows(snapshot, item) : diffRows(snapshot, item);
  return { item, rows };
}

/** Validates exact opaque row IDs against one immutable review item. */
export function resolveReviewLineSelection(
  snapshot: ReviewSnapshot,
  reviewItemId: string,
  selectedLineIds: readonly string[],
): ReviewLineSelection {
  if (selectedLineIds.length === 0 || new Set(selectedLineIds).size !== selectedLineIds.length) {
    throw new Error('review line selection must contain unique row ids');
  }
  const context = resolveReviewItemContext(snapshot, reviewItemId);
  const rowIds = new Set(context.rows.map((row) => row.id));
  if (selectedLineIds.some((lineId) => !rowIds.has(lineId))) {
    throw new Error('unknown review row in line selection');
  }
  return { kind: snapshot.kind, selectedLineIds: [...selectedLineIds] };
}
