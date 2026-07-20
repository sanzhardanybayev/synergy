import type { ScopeReviewSnapshot, SourceFile } from '@synergy/review-core';
import { describe, expect, it } from 'vitest';
import { type ScopeSectionRange, assertCompleteScopeCoverage } from './review-coverage.js';

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

function snapshot(files: SourceFile[]): ScopeReviewSnapshot {
  return {
    schemaVersion: 1,
    revisionId: 'rev-coverage',
    source: { kind: 'scope', patterns: ['src'], headSha: 'abc123' },
    fingerprint: 'fingerprint',
    createdAt: '2026-07-20T00:00:00.000Z',
    kind: 'scope',
    files,
    items: [],
  };
}

function section(
  key: string,
  start: number,
  end: number,
  path = 'src/example.ts',
): ScopeSectionRange {
  return { key, path, start, end };
}

describe('assertCompleteScopeCoverage', () => {
  it('accepts one exact section for a text file', () => {
    expect(() =>
      assertCompleteScopeCoverage(snapshot([textFile('src/example.ts', 3)]), [
        section('whole-file', 1, 3),
      ]),
    ).not.toThrow();
  });

  it('accepts exact adjacent sections across multiple text files regardless of input order', () => {
    expect(() =>
      assertCompleteScopeCoverage(
        snapshot([textFile('src/example.ts', 4), textFile('src/other.ts', 2)]),
        [
          section('example-bottom', 3, 4),
          section('other', 1, 2, 'src/other.ts'),
          section('example-top', 1, 2),
        ],
      ),
    ).not.toThrow();
  });

  it.each([
    {
      name: 'the first line',
      ranges: [section('rest', 2, 4)],
      offending: '2-4',
    },
    {
      name: 'a middle line',
      ranges: [section('first', 1, 1), section('rest', 3, 4)],
      offending: '3-4',
    },
    {
      name: 'the last line',
      ranges: [section('first', 1, 3)],
      offending: '1-3',
    },
  ])('rejects coverage missing $name', ({ ranges, offending }) => {
    expect(() =>
      assertCompleteScopeCoverage(snapshot([textFile('src/example.ts', 4)]), ranges),
    ).toThrow(new RegExp(`src/example\\.ts.*${offending}`, 'i'));
  });

  it('rejects the first overlapping range', () => {
    expect(() =>
      assertCompleteScopeCoverage(snapshot([textFile('src/example.ts', 4)]), [
        section('first', 1, 2),
        section('overlap', 2, 4),
      ]),
    ).toThrow(/src\/example\.ts.*2-4.*overlap/i);
  });

  it('rejects a reversed range before sorting', () => {
    expect(() =>
      assertCompleteScopeCoverage(snapshot([textFile('src/example.ts', 3)]), [
        section('reversed', 3, 2),
      ]),
    ).toThrow(/src\/example\.ts.*3-2.*reversed.*reversed/i);
  });

  it('rejects a range whose path was not captured', () => {
    expect(() =>
      assertCompleteScopeCoverage(snapshot([textFile('src/example.ts', 3)]), [
        section('missing', 1, 3, 'src/missing.ts'),
      ]),
    ).toThrow(/src\/missing\.ts.*1-3.*missing.*not captured/i);
  });

  it('rejects duplicate local keys and identifies both ranges', () => {
    expect(() =>
      assertCompleteScopeCoverage(snapshot([textFile('src/example.ts', 3)]), [
        section('duplicate', 1, 1),
        section('duplicate', 2, 3),
      ]),
    ).toThrow(/duplicate.*src\/example\.ts:2-3.*src\/example\.ts:1-1/i);
  });

  it('rejects a text file with no sections', () => {
    expect(() =>
      assertCompleteScopeCoverage(snapshot([textFile('src/example.ts', 3)]), []),
    ).toThrow(/src\/example\.ts.*no sections.*1-3/i);
  });

  it('rejects a range assigned to a binary file', () => {
    expect(() =>
      assertCompleteScopeCoverage(
        snapshot([
          textFile('src/example.ts', 1),
          { path: 'assets/image.png', binary: true, lines: [] },
        ]),
        [section('text', 1, 1), section('binary', 1, 1, 'assets/image.png')],
      ),
    ).toThrow(/assets\/image\.png.*1-1.*binary.*binary file/i);
  });

  it('rejects a range whose endpoint is not a captured line', () => {
    expect(() =>
      assertCompleteScopeCoverage(snapshot([textFile('src/example.ts', 3)]), [
        section('outside', 1, 4),
      ]),
    ).toThrow(/src\/example\.ts.*1-4.*outside.*captured line/i);
  });
});
