import type { DiffFile, DiffHunk, ReviewRange } from '@synergy/review-core';

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
 * with a removal). That anchor is clamped to line 1 - editors are 1-indexed and have no line 0,
 * so a hunk that opens with a removal at the very top of the file (`newStart` 1) still anchors on
 * a real, renderable line instead of producing an invalid 0-or-negative line number.
 */
export function hunkDecorationRanges(file: DiffFile, reviewItemId: string): HunkDecorationRanges {
  const hunk = file.hunks.find((candidate) => candidate.reviewItemId === reviewItemId);
  if (!hunk) {
    throw new Error(`No hunk found in ${file.path} for review item: ${reviewItemId}`);
  }
  return rangesForHunk(hunk);
}

/**
 * Union of every hunk's ranges in the file, for whole-file review (opening a file from its panel
 * row rather than a single hunk). Hunks without a `reviewItemId` still contribute - the editor
 * overlay should show every captured change, linked to a review item or not.
 */
export function fileDecorationRanges(file: DiffFile): HunkDecorationRanges {
  const added: ReviewRange[] = [];
  const removed: ReviewRange[] = [];
  for (const hunk of file.hunks) {
    const ranges = rangesForHunk(hunk);
    added.push(...ranges.added);
    removed.push(...ranges.removed);
  }
  return { added, removed };
}

function rangesForHunk(hunk: DiffHunk): HunkDecorationRanges {
  const added: ReviewRange[] = [];
  const removed: ReviewRange[] = [];
  let anchorLine = Math.max(1, hunk.newStart - 1);
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
