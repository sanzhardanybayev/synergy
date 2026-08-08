import type { ReviewSnapshot } from '@synergy/review-core';

/**
 * Reconstructed text for a captured-snapshot virtual document, plus whether it is the full
 * captured file or a fallback view.
 *
 * Scope snapshots capture every line of every file, so `text` is the exact captured file
 * content and `isFullReconstruction` is `true`.
 *
 * Diff snapshots only capture the changed hunks (never a full post-image), so a full-file
 * reconstruction is not possible in general - reconstructing one from hunks alone would require
 * knowing every unchanged line the diff never mentions. Rather than guess, `text` falls back to
 * the hunks' own +/- lines concatenated with their headers, and `isFullReconstruction` is
 * `false` so the caller can label the document honestly (see `ReviewViewProvider`).
 */
export interface SnapshotContent {
  text: string;
  isFullReconstruction: boolean;
}

/** Pure by design: no `vscode` import, so it is testable without an extension host. */
export function snapshotContentFor(
  snapshot: ReviewSnapshot,
  path: string,
): SnapshotContent | undefined {
  if (snapshot.kind === 'scope') {
    const file = snapshot.files.find((candidate) => candidate.path === path);
    if (!file || file.binary) return undefined;
    return { text: file.lines.map((line) => line.text).join('\n'), isFullReconstruction: true };
  }

  const file = snapshot.files.find((candidate) => candidate.path === path);
  if (!file || file.hunks.length === 0) return undefined;

  const parts = file.hunks.map((hunk) => {
    const body = hunk.lines
      .map((line) => {
        const marker = line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' ';
        return `${marker}${line.text}`;
      })
      .join('\n');
    return `${hunk.header}\n${body}`;
  });
  return { text: parts.join('\n\n'), isFullReconstruction: false };
}
