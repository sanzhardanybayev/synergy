import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type ReviewSnapshot, hashText } from '@synergy/review-core';
import { resolveBrowserReviewItemContext } from '@synergy/review-core/browser';

export type DriftState = 'clean' | 'drifted' | 'missing';

/**
 * Compares one captured file against its current text.
 *
 * Pure by design: `currentText` is a parameter rather than a filesystem read, so callers
 * (including tests) can construct exact scenarios without touching disk. Use
 * `fileDriftOnDisk` to read the file for a real project root.
 *
 * - `currentText === undefined` means the file no longer exists on disk -> 'missing'.
 * - Scope snapshots capture every line of the file, so we can reconstruct the exact captured
 *   text (`SourceFile.lines`) and compare it byte-for-byte against the current text. If the
 *   path was never captured in this snapshot (not in `snapshot.files`) or was captured as
 *   binary (`SourceFile.binary`), there is no captured text to compare against, so we report
 *   'clean' rather than guessing - the same honest-limitation stance documented below for the
 *   diff branch's incomparable cases.
 * - Diff snapshots only capture the changed hunks (and, for whole-file changes, no textual rows
 *   at all), so a full-file reconstruction is not possible in general. Instead we resolve each
 *   review item's captured context rows and check that the rows which map onto a stable
 *   position in the CURRENT file - i.e. `add`/`context` rows, which carry a `newLine` - still
 *   read back the same text at that line. `remove` rows describe text that is no longer present
 *   in the current file by definition and are skipped. File-level items (whole added/deleted/
 *   renamed files with no hunk) carry no comparable rows; for those - and for any path the
 *   snapshot never captured at all - there is nothing to compare, so we report 'clean' rather
 *   than guessing. This is a conservative, honest limitation: drift on such files can only be
 *   detected by a full re-capture, not by this pointwise check.
 * - Line-ending normalization: captured text is always reconstructed from parsed line records
 *   (no `\r`), while `currentText` is read verbatim from disk and may still carry `\r\n` on
 *   Windows-authored or CRLF-checked-out files. Both sides are normalized to `\n` before any
 *   comparison so a CRLF-only difference is never reported as drift.
 */
export function fileDrift(
  currentText: string | undefined,
  snapshot: ReviewSnapshot,
  path: string,
): DriftState {
  if (currentText === undefined) return 'missing';
  const normalizedCurrentText = normalizeLineEndings(currentText);

  if (snapshot.kind === 'scope') {
    const file = snapshot.files.find((candidate) => candidate.path === path);
    if (!file || file.binary) return 'clean';
    const capturedText = file.lines.map((line) => line.text).join('\n');
    return hashText(capturedText) === hashText(normalizedCurrentText) ? 'clean' : 'drifted';
  }

  const items = snapshot.items.filter((item) => item.path === path);
  if (items.length === 0) return 'clean';

  const currentLines = normalizedCurrentText.split('\n');
  for (const item of items) {
    let context: ReturnType<typeof resolveBrowserReviewItemContext>;
    try {
      context = resolveBrowserReviewItemContext(snapshot, item.id);
    } catch {
      // Captured metadata no longer resolves against this snapshot (should not happen for an
      // immutable snapshot); treat as drifted rather than silently skipping the check.
      return 'drifted';
    }
    for (const row of context.rows) {
      if (row.kind !== 'add' && row.kind !== 'context') continue;
      if (row.newLine === null) continue;
      const currentLine = currentLines[row.newLine - 1];
      const capturedLine = normalizeLineEndings(row.text);
      if (currentLine === undefined || hashText(currentLine) !== hashText(capturedLine)) {
        return 'drifted';
      }
    }
  }
  return 'clean';
}

/** Normalizes CRLF to LF so line-ending style alone never registers as content drift. */
function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

function readFileTextOrUndefined(absolutePath: string): string | undefined {
  try {
    return readFileSync(absolutePath, 'utf8');
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

/** Thin filesystem wrapper around `fileDrift` for a real project root. */
export function fileDriftOnDisk(
  projectRoot: string,
  snapshot: ReviewSnapshot,
  path: string,
): DriftState {
  const currentText = readFileTextOrUndefined(join(projectRoot, path));
  return fileDrift(currentText, snapshot, path);
}
