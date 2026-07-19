import type { ReviewSnapshot, ScopeReviewSnapshot, SourceFile } from '@synergy/review-core';
import { describe, expect, it } from 'vitest';
import { deriveReviewAnalysisGuidance } from './review-analysis-guidance.js';

function textFile(path: string, lineCount: number): SourceFile {
  return {
    path,
    binary: false,
    lines: Array.from({ length: lineCount }, (_, index) => ({
      number: index + 1,
      text: `line ${index + 1}`,
    })),
  };
}

function scopeSnapshot(files: SourceFile[]): ScopeReviewSnapshot {
  return {
    schemaVersion: 1,
    revisionId: 'rev-guidance',
    source: { kind: 'scope', patterns: ['src'], headSha: 'abc123' },
    fingerprint: 'fingerprint',
    createdAt: '2026-07-20T00:00:00.000Z',
    kind: 'scope',
    files,
    items: [],
  };
}

describe('deriveReviewAnalysisGuidance', () => {
  it.each([
    {
      name: 'an empty scope',
      files: [],
      expected: {
        textFiles: 0,
        textLines: 0,
        minimumSections: 0,
        targetSections: 0,
        maximumSections: 0,
        scopeTooBroad: false,
      },
    },
    {
      name: 'one short text file',
      files: [textFile('src/short.ts', 12)],
      expected: {
        textFiles: 1,
        textLines: 12,
        minimumSections: 1,
        targetSections: 1,
        maximumSections: 1,
        scopeTooBroad: false,
      },
    },
    {
      name: 'the 15-file 3,035-line incident scope',
      files: [
        ...Array.from({ length: 14 }, (_, index) => textFile(`src/file-${index}.ts`, 200)),
        textFile('src/file-14.ts', 235),
      ],
      expected: {
        textFiles: 15,
        textLines: 3_035,
        minimumSections: 21,
        targetSections: 26,
        maximumSections: 30,
        scopeTooBroad: false,
      },
    },
    {
      name: 'more than 30 text files',
      files: Array.from({ length: 31 }, (_, index) => textFile(`src/file-${index}.ts`, 1)),
      expected: {
        textFiles: 31,
        textLines: 31,
        minimumSections: 31,
        targetSections: 31,
        maximumSections: 31,
        scopeTooBroad: true,
      },
    },
    {
      name: 'more than 4,500 text lines',
      files: [textFile('src/large.ts', 4_501)],
      expected: {
        textFiles: 1,
        textLines: 4_501,
        minimumSections: 30,
        targetSections: 30,
        maximumSections: 30,
        scopeTooBroad: true,
      },
    },
    {
      name: 'binary files excluded from both counts',
      files: [
        textFile('src/source.ts', 2),
        { path: 'assets/a.bin', binary: true, lines: [] },
        { path: 'assets/b.bin', binary: true, lines: [] },
      ],
      expected: {
        textFiles: 1,
        textLines: 2,
        minimumSections: 1,
        targetSections: 1,
        maximumSections: 1,
        scopeTooBroad: false,
      },
    },
  ])('derives bounded guidance for $name', ({ files, expected }) => {
    expect(deriveReviewAnalysisGuidance(scopeSnapshot(files))).toEqual(expected);
  });

  it('does not mutate captured snapshot data', () => {
    const snapshot: ReviewSnapshot = scopeSnapshot([textFile('src/example.ts', 2)]);
    const before = structuredClone(snapshot);

    deriveReviewAnalysisGuidance(snapshot);

    expect(snapshot).toEqual(before);
  });
});
