import type { DiffFile, ReviewRange } from '@synergy/review-core';

/**
 * Gutter/background decoration ranges for a single hunk, expressed in the coordinates the
 * current (new) file uses - i.e. what `Host.openFileAt` and `vscode.TextEditor` already work in.
 * `removed` ranges do not point at real removed text (it no longer exists in the new file); they
 * anchor at the new-file line immediately after which content was removed, so a caller can render
 * a marker there (e.g. a thin border) without inventing phantom lines.
 */
export interface HunkDecorationRanges {
  added: ReviewRange[];
  removed: ReviewRange[];
}

/**
 * Pure range math: no `vscode` import, so this is unit-testable without an extension host.
 * Walks `hunk.lines` tracking the new-file line position. Contiguous `add` lines collapse into a
 * single added range; contiguous `remove` lines collapse into a single removed anchor at the
 * new-file line position immediately preceding the run (or `hunk.newStart - 1` if the hunk opens
 * with a removal).
 */
export function hunkDecorationRanges(file: DiffFile, reviewItemId: string): HunkDecorationRanges {
  const hunk = file.hunks.find((candidate) => candidate.reviewItemId === reviewItemId);
  if (!hunk) {
    throw new Error(`No hunk found in ${file.path} for review item: ${reviewItemId}`);
  }

  const added: ReviewRange[] = [];
  const removed: ReviewRange[] = [];
  let anchorLine = hunk.newStart - 1;
  let previousKind: 'context' | 'add' | 'remove' | undefined;

  for (const line of hunk.lines) {
    if (line.kind === 'add') {
      const last = previousKind === 'add' ? added[added.length - 1] : undefined;
      if (last && line.newLine !== null) {
        last.end = line.newLine;
      } else {
        const start = line.newLine ?? anchorLine + 1;
        added.push({ start, end: start });
      }
      if (line.newLine !== null) anchorLine = line.newLine;
    } else if (line.kind === 'remove') {
      if (previousKind !== 'remove') {
        removed.push({ start: anchorLine, end: anchorLine });
      }
    } else {
      if (line.newLine !== null) anchorLine = line.newLine;
    }
    previousKind = line.kind;
  }

  return { added, removed };
}
