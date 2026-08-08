import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DiffFile, ReviewSnapshot, ReviewSource } from '@synergy/review-core';

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

export interface BaseContentResult {
  text: string;
  origin: 'reverse-apply' | 'git' | 'hunks-only';
}

/**
 * The git revision whose tree holds the BASE side of this snapshot's diff. PR captures diff
 * base..head, so the base tree is `baseSha`. Staged captures diff HEAD..index, so the base tree
 * is HEAD (`headSha`). Unstaged captures diff index..worktree, so the base is the index itself -
 * `git show :<path>` (the empty-revision stage-0 form).
 */
function baseGitRef(source: ReviewSource): string | undefined {
  switch (source.kind) {
    case 'pr':
      return source.baseSha;
    case 'staged':
      return source.headSha;
    case 'unstaged':
      return '';
    default:
      return undefined;
  }
}

/**
 * Resolves the pre-change content of `path` for the base side of a native diff, trying sources
 * in decreasing fidelity: exact reverse-apply against the on-disk file, then the captured base
 * git revision, then the hunks' own context/removed lines. Disk and git access are injected so
 * the decision ladder stays unit-testable without a filesystem or repository.
 */
export function resolveBaseContent(opts: {
  snapshot: ReviewSnapshot;
  path: string;
  readDisk: (path: string) => string | undefined;
  gitShow: (ref: string, path: string) => string | undefined;
}): BaseContentResult | undefined {
  const { snapshot, path } = opts;
  if (snapshot.kind !== 'diff') return undefined;
  const file = snapshot.files.find((candidate) => candidate.path === path);
  if (!file || file.binary) return undefined;

  if (file.status === 'added') return { text: '', origin: 'reverse-apply' };

  const diskText = opts.readDisk(path);
  if (diskText !== undefined) {
    const reversed = reverseApplyHunks(diskText, file);
    if (reversed !== undefined) return { text: reversed, origin: 'reverse-apply' };
  }

  const ref = baseGitRef(snapshot.source);
  if (ref !== undefined) {
    const shown = opts.gitShow(ref, file.previousPath ?? path);
    if (shown !== undefined) return { text: shown, origin: 'git' };
  }

  if (file.hunks.length === 0) return undefined;
  return { text: baseTextFromHunks(file), origin: 'hunks-only' };
}

/**
 * Production wiring for {@link resolveBaseContent}: reads the working tree with `fs` and the
 * base revision with `git show <ref>:<path>` (an empty ref yields `:<path>`, the index form).
 * Both accessors swallow their failures into `undefined` - a missing file, a missing sha, or a
 * non-git workspace are all normal fallback-ladder steps here, not errors to surface.
 */
export function resolveBaseContentFromProject(
  projectRoot: string,
  snapshot: ReviewSnapshot,
  path: string,
): BaseContentResult | undefined {
  return resolveBaseContent({
    snapshot,
    path,
    readDisk: (relative) => {
      try {
        return readFileSync(join(projectRoot, relative), 'utf8');
      } catch {
        return undefined;
      }
    },
    gitShow: (ref, relative) => {
      try {
        return execFileSync('git', ['show', `${ref}:${relative}`], {
          cwd: projectRoot,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
          maxBuffer: 64 * 1024 * 1024,
        });
      } catch {
        return undefined;
      }
    },
  });
}
