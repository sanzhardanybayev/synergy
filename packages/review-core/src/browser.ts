import { reviewRowId } from './review-row-id.js';
export { deriveReviewReadiness } from './readiness.js';
import type { ReviewItemContext, ReviewLineRow, ReviewSnapshot } from './types.js';

/** Serializes review records with sorted object keys while preserving array order. */
export function stableReviewJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableReviewJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableReviewJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

/** Browser-safe canonical row contexts for immutable review items. */
export function resolveBrowserReviewItemContext(
  snapshot: ReviewSnapshot,
  reviewItemId: string,
): ReviewItemContext {
  const matchingItems = snapshot.items.filter((candidate) => candidate.id === reviewItemId);
  if (matchingItems.length === 0) throw new Error('unknown review item');
  if (matchingItems.length !== 1) throw new Error('review item identity is ambiguous');
  const item = matchingItems[0]!;
  if (snapshot.kind === 'scope' && item.kind === 'code-section') {
    const file = snapshot.files.find((candidate) => candidate.path === item.path);
    if (!file || file.binary) throw new Error('review item source file is unavailable');
    const rows: ReviewLineRow[] = file.lines
      .filter((line) => line.number >= item.range.start && line.number <= item.range.end)
      .map((line, position) => ({
        id: reviewRowId(item.id, position),
        kind: 'scope',
        line: line.number,
        text: line.text,
      }));
    if (rows.length !== item.range.end - item.range.start + 1) throw new Error('incomplete item');
    return { item, rows };
  }
  if (snapshot.kind === 'diff' && item.kind === 'hunk') {
    const file = snapshot.files.find((candidate) => candidate.path === item.path);
    const matchingHunks = file?.hunks.filter(
      (candidate) =>
        candidate.reviewItemId === item.id &&
        candidate.reviewItemContentHash === item.contentHash &&
        candidate.reviewItemLocationHash === item.locationHash &&
        candidate.header === item.label &&
        Math.max(1, candidate.newStart) === item.range.start &&
        (candidate.newLines === 0
          ? item.range.start
          : candidate.newStart + candidate.newLines - 1) === item.range.end,
    );
    if (!matchingHunks || matchingHunks.length !== 1) {
      throw new Error('review item diff hunk is unavailable');
    }
    const hunk = matchingHunks[0]!;
    return {
      item,
      rows: hunk.lines.map((line, position) => ({
        id: reviewRowId(item.id, position),
        kind: line.kind,
        oldLine: line.oldLine,
        newLine: line.newLine,
        text: line.text,
        ...(line.noNewlineAtEnd === undefined ? {} : { noNewlineAtEnd: line.noNewlineAtEnd }),
      })),
    };
  }
  if (snapshot.kind === 'diff' && item.kind === 'file') {
    const matchingFiles = snapshot.files.filter(
      (file) =>
        file.path === item.path &&
        file.reviewItemId === item.id &&
        file.reviewItemContentHash === item.contentHash &&
        file.reviewItemLocationHash === item.locationHash,
    );
    if (matchingFiles.length !== 1) {
      throw new Error('review item file change is unavailable');
    }
    return { item, rows: [] };
  }
  throw new Error('review item kind does not match its snapshot');
}

// Re-exported here (rather than from ./removals.js directly by consumers) because removals.ts
// itself imports resolveBrowserReviewItemContext from this module - keeping removal derivation
// free of node-only imports (hash.js/review-lines.js pull in node:crypto) so the preview app and
// VS Code webview bundlers can resolve this entry point.
export { buildRemovalStrips, deriveRemovalRuns } from './removals.js';
