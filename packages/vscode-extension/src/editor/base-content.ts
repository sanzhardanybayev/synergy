import type { DiffFile } from '@synergy/review-core';

/**
 * Reconstructs the pre-change (base) content of `file` from the current on-disk text by removing
 * the diff's `add` lines and re-inserting its `remove` lines. Verification-first: every `context`
 * and `add` line is checked against the disk text at its new-file position, and any mismatch
 * (drifted file, truncated file) returns `undefined` so the caller can fall back to another base
 * source instead of producing a silently wrong reconstruction.
 *
 * Pure by design: no `vscode` import, so it is testable without an extension host.
 */
export function reverseApplyHunks(diskText: string, file: DiffFile): string | undefined {
  if (file.binary) return undefined;
  if (file.status === 'added') return '';

  const diskHasTrailingNewline = diskText.endsWith('\n');
  const diskLines = diskText === '' ? [] : diskText.split('\n');
  if (diskHasTrailingNewline) diskLines.pop();

  const out: string[] = [];
  // Next disk (new-file) line number, 1-indexed, that has not been consumed yet.
  let cursor = 1;
  // Whether the last emitted base line carried `noNewlineAtEnd` (old file ended without '\n').
  let lastEmittedNoNewline = false;

  for (const hunk of file.hunks) {
    while (cursor < hunk.newStart) {
      if (cursor > diskLines.length) return undefined;
      out.push(diskLines[cursor - 1]);
      lastEmittedNoNewline = false;
      cursor += 1;
    }
    for (const line of hunk.lines) {
      if (line.kind === 'remove') {
        out.push(line.text);
        lastEmittedNoNewline = line.noNewlineAtEnd === true;
        continue;
      }
      // `context` and `add` both exist in the new file: verify against disk before consuming.
      if (diskLines[cursor - 1] !== line.text) return undefined;
      cursor += 1;
      if (line.kind === 'context') {
        out.push(line.text);
        lastEmittedNoNewline = line.noNewlineAtEnd === true;
      }
    }
  }

  let tailCopied = false;
  while (cursor <= diskLines.length) {
    out.push(diskLines[cursor - 1]);
    cursor += 1;
    tailCopied = true;
  }

  if (out.length === 0) return '';
  const trailingNewline = tailCopied ? diskHasTrailingNewline : !lastEmittedNoNewline;
  return out.join('\n') + (trailingNewline ? '\n' : '');
}

/**
 * Best-effort base text from the captured hunks alone (context + removed lines, added lines
 * skipped). Not a full-file reconstruction - unchanged lines outside the hunks are absent - but
 * it is the only base view available when both the disk reverse-apply and the git fallback fail
 * (e.g. a deleted file in a repo whose baseSha is gone).
 */
export function baseTextFromHunks(file: DiffFile): string {
  const out: string[] = [];
  let lastNoNewline = false;
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.kind === 'add') continue;
      out.push(line.text);
      lastNoNewline = line.noNewlineAtEnd === true;
    }
  }
  if (out.length === 0) return '';
  return out.join('\n') + (lastNoNewline ? '' : '\n');
}
