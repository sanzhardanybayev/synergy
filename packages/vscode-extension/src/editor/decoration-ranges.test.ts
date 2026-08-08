import type { DiffFile } from '@synergy/review-core';
import { describe, expect, it } from 'vitest';
import { hunkDecorationRanges } from './decoration-ranges.js';

function fileWithHunk(overrides: Partial<DiffFile['hunks'][number]> = {}): DiffFile {
  return {
    path: 'src/example.ts',
    status: 'modified',
    additions: 3,
    deletions: 0,
    binary: false,
    hunks: [
      {
        reviewItemId: 'item-1',
        reviewItemContentHash: 'content-hash-1',
        reviewItemLocationHash: 'loc-1',
        header: '@@ -8,4 +8,6 @@',
        oldStart: 8,
        oldLines: 4,
        newStart: 10,
        newLines: 6,
        lines: [],
        ...overrides,
      },
    ],
  };
}

describe('hunkDecorationRanges', () => {
  it('maps an add-only hunk to one added range in new-file coordinates', () => {
    const file = fileWithHunk({
      lines: [
        { kind: 'context', text: 'a', oldLine: 8, newLine: 10 },
        { kind: 'context', text: 'b', oldLine: 9, newLine: 11 },
        { kind: 'add', text: 'c', oldLine: null, newLine: 12 },
        { kind: 'add', text: 'd', oldLine: null, newLine: 13 },
        { kind: 'add', text: 'e', oldLine: null, newLine: 14 },
        { kind: 'context', text: 'f', oldLine: 10, newLine: 15 },
      ],
    });

    expect(hunkDecorationRanges(file, 'item-1')).toEqual({
      added: [{ start: 12, end: 14 }],
      removed: [],
    });
  });

  it('maps remove-only lines to a removed anchor at the preceding new-file line', () => {
    const file = fileWithHunk({
      lines: [
        { kind: 'context', text: 'a', oldLine: 8, newLine: 10 },
        { kind: 'context', text: 'b', oldLine: 9, newLine: 11 },
        { kind: 'remove', text: 'c', oldLine: 10, newLine: null },
        { kind: 'remove', text: 'd', oldLine: 11, newLine: null },
        { kind: 'context', text: 'e', oldLine: 12, newLine: 12 },
      ],
    });

    expect(hunkDecorationRanges(file, 'item-1')).toEqual({
      added: [],
      removed: [{ start: 11, end: 11 }],
    });
  });

  it('collapses two separate add runs into two ranges', () => {
    const file = fileWithHunk({
      lines: [
        { kind: 'add', text: 'a', oldLine: null, newLine: 10 },
        { kind: 'add', text: 'b', oldLine: null, newLine: 11 },
        { kind: 'context', text: 'c', oldLine: 8, newLine: 12 },
        { kind: 'add', text: 'd', oldLine: null, newLine: 13 },
      ],
    });

    expect(hunkDecorationRanges(file, 'item-1')).toEqual({
      added: [
        { start: 10, end: 11 },
        { start: 13, end: 13 },
      ],
      removed: [],
    });
  });

  it('anchors a leading remove run (before any context/add line) at newStart - 1', () => {
    const file = fileWithHunk({
      newStart: 10,
      lines: [
        { kind: 'remove', text: 'a', oldLine: 8, newLine: null },
        { kind: 'context', text: 'b', oldLine: 9, newLine: 10 },
      ],
    });

    expect(hunkDecorationRanges(file, 'item-1')).toEqual({
      added: [],
      removed: [{ start: 9, end: 9 }],
    });
  });

  it('clamps the removed anchor to line 1 when a hunk opens with a remove at newStart 1', () => {
    const file = fileWithHunk({
      newStart: 1,
      lines: [
        { kind: 'remove', text: 'a', oldLine: 1, newLine: null },
        { kind: 'context', text: 'b', oldLine: 2, newLine: 1 },
      ],
    });

    expect(hunkDecorationRanges(file, 'item-1')).toEqual({
      added: [],
      removed: [{ start: 1, end: 1 }],
    });
  });

  it('throws for unknown reviewItemId', () => {
    const file = fileWithHunk({ lines: [] });
    expect(() => hunkDecorationRanges(file, 'missing-item')).toThrow();
  });
});
