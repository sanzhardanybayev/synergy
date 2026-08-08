import type {
  DiffFile,
  DiffHunk,
  DiffLine,
  DiffReviewSnapshot,
  ReviewSource,
} from '@synergy/review-core';
import { describe, expect, it } from 'vitest';
import { baseTextFromHunks, resolveBaseContent, reverseApplyHunks } from './base-content.js';

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

describe('resolveBaseContent', () => {
  const prSource: ReviewSource = {
    kind: 'pr',
    number: 1,
    url: 'https://example.test/pr/1',
    baseSha: 'base-sha',
    headSha: 'head-sha',
  };

  function snapshot(files: DiffFile[], source: ReviewSource = prSource): DiffReviewSnapshot {
    return {
      schemaVersion: 1,
      revisionId: 'rev-1',
      source,
      fingerprint: 'fp',
      createdAt: '2026-08-09T00:00:00.000Z',
      items: [],
      kind: 'diff',
      files,
    };
  }

  const modified = file({
    hunks: [
      hunk({
        oldStart: 1,
        newStart: 1,
        lines: [line('remove', 'old', 1, null), line('add', 'new', null, 1)],
      }),
    ],
  });

  it('prefers reverse-apply against the disk content', () => {
    const result = resolveBaseContent({
      snapshot: snapshot([modified]),
      path: modified.path,
      readDisk: () => 'new\n',
      gitShow: () => {
        throw new Error('git must not be consulted when reverse-apply succeeds');
      },
    });
    expect(result).toEqual({ text: 'old\n', origin: 'reverse-apply' });
  });

  it('falls back to git show at baseSha when the disk content drifted', () => {
    const calls: string[][] = [];
    const result = resolveBaseContent({
      snapshot: snapshot([modified]),
      path: modified.path,
      readDisk: () => 'DRIFTED\n',
      gitShow: (ref, path) => {
        calls.push([ref, path]);
        return 'old\n';
      },
    });
    expect(result).toEqual({ text: 'old\n', origin: 'git' });
    expect(calls).toEqual([['base-sha', modified.path]]);
  });

  it('uses previousPath for the git lookup on renamed files', () => {
    const renamed = { ...modified, status: 'renamed' as const, previousPath: 'src/old-name.ts' };
    const calls: string[][] = [];
    resolveBaseContent({
      snapshot: snapshot([renamed]),
      path: renamed.path,
      readDisk: () => undefined,
      gitShow: (ref, path) => {
        calls.push([ref, path]);
        return 'old\n';
      },
    });
    expect(calls).toEqual([['base-sha', 'src/old-name.ts']]);
  });

  it('resolves the staged base from HEAD and the unstaged base from the index', () => {
    const refs: string[] = [];
    const gitShow = (ref: string): string => {
      refs.push(ref);
      return 'old\n';
    };
    resolveBaseContent({
      snapshot: snapshot([modified], { kind: 'staged', headSha: 'head-sha' }),
      path: modified.path,
      readDisk: () => undefined,
      gitShow,
    });
    resolveBaseContent({
      snapshot: snapshot([modified], { kind: 'unstaged', headSha: 'head-sha' }),
      path: modified.path,
      readDisk: () => undefined,
      gitShow,
    });
    expect(refs).toEqual(['head-sha', '']);
  });

  it('degrades to hunks-only text when disk and git both fail', () => {
    const result = resolveBaseContent({
      snapshot: snapshot([modified]),
      path: modified.path,
      readDisk: () => undefined,
      gitShow: () => undefined,
    });
    expect(result).toEqual({ text: 'old\n', origin: 'hunks-only' });
  });

  it('returns empty base for added files without consulting disk or git', () => {
    const added = { ...modified, status: 'added' as const };
    const result = resolveBaseContent({
      snapshot: snapshot([added]),
      path: added.path,
      readDisk: () => {
        throw new Error('disk must not be read for added files');
      },
      gitShow: () => {
        throw new Error('git must not be consulted for added files');
      },
    });
    expect(result).toEqual({ text: '', origin: 'reverse-apply' });
  });

  it('returns undefined for binary files and unknown paths', () => {
    const binary = { ...modified, binary: true };
    const args = { readDisk: (): undefined => undefined, gitShow: (): undefined => undefined };
    expect(
      resolveBaseContent({ snapshot: snapshot([binary]), path: binary.path, ...args }),
    ).toBeUndefined();
    expect(
      resolveBaseContent({ snapshot: snapshot([modified]), path: 'nope.ts', ...args }),
    ).toBeUndefined();
  });
});
