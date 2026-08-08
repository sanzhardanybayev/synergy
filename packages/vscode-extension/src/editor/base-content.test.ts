import type { DiffFile, DiffHunk, DiffLine } from '@synergy/review-core';
import { describe, expect, it } from 'vitest';
import { baseTextFromHunks, reverseApplyHunks } from './base-content.js';

function line(
  kind: DiffLine['kind'],
  text: string,
  oldLine: number | null,
  newLine: number | null,
): DiffLine {
  return { kind, text, oldLine, newLine };
}

function hunk(partial: Partial<DiffHunk> & Pick<DiffHunk, 'lines'>): DiffHunk {
  const oldStart = partial.oldStart ?? 1;
  const newStart = partial.newStart ?? 1;
  return {
    header: partial.header ?? `@@ -${oldStart},0 +${newStart},0 @@`,
    oldStart,
    oldLines: partial.oldLines ?? 0,
    newLines: partial.newLines ?? 0,
    newStart,
    ...partial,
  };
}

function file(partial: Partial<DiffFile>): DiffFile {
  return {
    path: 'src/example.ts',
    status: 'modified',
    additions: 0,
    deletions: 0,
    binary: false,
    hunks: [],
    ...partial,
  };
}

describe('reverseApplyHunks', () => {
  it('reconstructs base content for a mixed context/add/remove hunk', () => {
    // base:            new (disk):
    //   alpha            alpha
    //   old-line         new-line
    //   omega            omega
    const disk = 'alpha\nnew-line\nomega\n';
    const target = file({
      hunks: [
        hunk({
          oldStart: 1,
          newStart: 1,
          lines: [
            line('context', 'alpha', 1, 1),
            line('remove', 'old-line', 2, null),
            line('add', 'new-line', null, 2),
            line('context', 'omega', 3, 3),
          ],
        }),
      ],
    });
    expect(reverseApplyHunks(disk, target)).toBe('alpha\nold-line\nomega\n');
  });

  it('handles multiple hunks with unchanged lines between them', () => {
    const disk = 'one\ntwo-new\nthree\nfour\nfive\nsix-new\nseven\n';
    const target = file({
      hunks: [
        hunk({
          oldStart: 2,
          newStart: 2,
          lines: [line('remove', 'two', 2, null), line('add', 'two-new', null, 2)],
        }),
        hunk({
          oldStart: 6,
          newStart: 6,
          lines: [line('remove', 'six', 6, null), line('add', 'six-new', null, 6)],
        }),
      ],
    });
    expect(reverseApplyHunks(disk, target)).toBe('one\ntwo\nthree\nfour\nfive\nsix\nseven\n');
  });

  it('returns empty base for an added file without reading disk text', () => {
    const target = file({
      status: 'added',
      hunks: [hunk({ oldStart: 0, newStart: 1, lines: [line('add', 'anything', null, 1)] })],
    });
    expect(reverseApplyHunks('anything\n', target)).toBe('');
  });

  it('returns undefined when disk content no longer matches the hunk (drift)', () => {
    const disk = 'alpha\nDRIFTED\nomega\n';
    const target = file({
      hunks: [
        hunk({
          oldStart: 1,
          newStart: 1,
          lines: [
            line('context', 'alpha', 1, 1),
            line('add', 'new-line', null, 2),
            line('context', 'omega', 2, 3),
          ],
        }),
      ],
    });
    expect(reverseApplyHunks(disk, target)).toBeUndefined();
  });

  it('returns undefined when the disk file is shorter than the hunk expects', () => {
    const disk = 'alpha\n';
    const target = file({
      hunks: [
        hunk({
          oldStart: 1,
          newStart: 1,
          lines: [line('context', 'alpha', 1, 1), line('add', 'beta', null, 2)],
        }),
      ],
    });
    expect(reverseApplyHunks(disk, target)).toBeUndefined();
  });

  it('preserves a missing trailing newline signalled on the last removed line', () => {
    // Old file ended without trailing newline; new file replaced the last line.
    const disk = 'alpha\nnew-end\n';
    const target = file({
      hunks: [
        hunk({
          oldStart: 1,
          newStart: 1,
          lines: [
            line('context', 'alpha', 1, 1),
            { ...line('remove', 'old-end', 2, null), noNewlineAtEnd: true },
            line('add', 'new-end', null, 2),
          ],
        }),
      ],
    });
    expect(reverseApplyHunks(disk, target)).toBe('alpha\nold-end');
  });

  it('preserves the disk trailing-newline state when the tail is copied from disk', () => {
    const disk = 'changed\nkept';
    const target = file({
      hunks: [
        hunk({
          oldStart: 1,
          newStart: 1,
          lines: [line('remove', 'original', 1, null), line('add', 'changed', null, 1)],
        }),
      ],
    });
    expect(reverseApplyHunks(disk, target)).toBe('original\nkept');
  });

  it('returns undefined for binary files', () => {
    expect(reverseApplyHunks('anything', file({ binary: true }))).toBeUndefined();
  });
});

describe('baseTextFromHunks', () => {
  it('joins context and removed lines, skipping added lines', () => {
    const target = file({
      hunks: [
        hunk({
          oldStart: 1,
          newStart: 1,
          lines: [
            line('context', 'alpha', 1, 1),
            line('remove', 'old-line', 2, null),
            line('add', 'new-line', null, 2),
          ],
        }),
        hunk({
          oldStart: 9,
          newStart: 9,
          lines: [line('remove', 'gone', 9, null)],
        }),
      ],
    });
    expect(baseTextFromHunks(target)).toBe('alpha\nold-line\ngone\n');
  });
});
