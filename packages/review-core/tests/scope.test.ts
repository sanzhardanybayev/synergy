import { describe, expect, it } from 'vitest';
import {
  type ReviewSource,
  type SourceFile,
  applyCodeSections,
  buildScopeSnapshot,
} from '../src/index.js';

const SCOPE_SOURCE: ReviewSource = {
  kind: 'scope',
  patterns: ['src/**/*.ts'],
  headSha: 'abc1234',
};

const SOURCE_FILES: SourceFile[] = [
  {
    path: 'src/math.ts',
    binary: false,
    lines: [
      { number: 1, text: 'const OFFSET = 1;' },
      { number: 2, text: '' },
      { number: 3, text: 'export function add(left: number, right: number): number {' },
      { number: 4, text: '  return left + right + OFFSET;' },
      { number: 5, text: '}' },
      { number: 6, text: '' },
      { number: 7, text: 'export function subtract(left: number, right: number): number {' },
      { number: 8, text: '  return left - right;' },
      { number: 9, text: '}' },
    ],
  },
  { path: 'assets/logo.png', binary: true, lines: [] },
];

function makeSnapshot(files: SourceFile[] = SOURCE_FILES) {
  return buildScopeSnapshot({
    revisionId: 'scope-abc1234',
    source: SCOPE_SOURCE,
    fingerprint: 'scope-fingerprint',
    createdAt: '2026-07-19T10:00:00.000Z',
    files,
  });
}

describe('scoped snapshots', () => {
  it('starts with text files and no agent-proposed review items', () => {
    const snapshot = makeSnapshot();

    expect(snapshot).toMatchObject({
      kind: 'scope',
      files: SOURCE_FILES,
      items: [],
    });
  });

  it('builds a code-section item with exact content and bounded structural context', () => {
    const snapshot = applyCodeSections(makeSnapshot(), [
      {
        path: 'src/math.ts',
        label: 'add',
        parentLabel: 'math utilities',
        start: 3,
        end: 5,
      },
    ]);

    expect(snapshot.items).toHaveLength(1);
    expect(snapshot.items[0]).toMatchObject({
      kind: 'code-section',
      path: 'src/math.ts',
      label: 'add',
      range: { start: 3, end: 5 },
    });
    expect(snapshot.items[0]?.contentHash).toHaveLength(64);
    expect(snapshot.items[0]?.locationHash).toHaveLength(64);
  });

  it('keeps code-section identity stable when unrelated lines are inserted above it', () => {
    const original = applyCodeSections(makeSnapshot(), [
      { path: 'src/math.ts', label: 'add', parentLabel: 'math utilities', start: 3, end: 5 },
    ]).items[0]!;
    const shiftedFiles: SourceFile[] = [
      {
        ...SOURCE_FILES[0]!,
        lines: [
          { number: 1, text: '// unrelated header' },
          ...SOURCE_FILES[0]!.lines.map((line) => ({ ...line, number: line.number + 1 })),
        ],
      },
      SOURCE_FILES[1]!,
    ];
    const shifted = applyCodeSections(makeSnapshot(shiftedFiles), [
      { path: 'src/math.ts', label: 'add', parentLabel: 'math utilities', start: 4, end: 6 },
    ]).items[0]!;

    expect(shifted).toMatchObject({
      id: original.id,
      contentHash: original.contentHash,
      locationHash: original.locationHash,
    });
    expect(shifted.range).not.toEqual(original.range);
  });

  it('rejects repeated semantic sections and requests distinct analysis context', () => {
    const repeatedFiles: SourceFile[] = [
      {
        path: 'src/repeated.ts',
        binary: false,
        lines: [
          { number: 1, text: 'before one' },
          { number: 2, text: 'before two' },
          { number: 3, text: 'selected' },
          { number: 4, text: 'after one' },
          { number: 5, text: 'after two' },
          { number: 6, text: 'before one' },
          { number: 7, text: 'before two' },
          { number: 8, text: 'selected' },
          { number: 9, text: 'after one' },
          { number: 10, text: 'after two' },
        ],
      },
    ];

    expect(() =>
      applyCodeSections(makeSnapshot(repeatedFiles), [
        { path: 'src/repeated.ts', label: 'handler', parentLabel: 'module', start: 3, end: 3 },
        { path: 'src/repeated.ts', label: 'handler', parentLabel: 'module', start: 8, end: 8 },
      ]),
    ).toThrow(/duplicate code-section identity.*distinct label or parentLabel/i);
  });

  it.each([
    {
      label: 'missing path',
      sections: [{ path: 'src/missing.ts', label: 'missing', start: 1, end: 1 }],
    },
    {
      label: 'traversal path',
      sections: [{ path: '../outside.ts', label: 'outside', start: 1, end: 1 }],
    },
    {
      label: 'binary file',
      sections: [{ path: 'assets/logo.png', label: 'logo', start: 1, end: 1 }],
    },
    {
      label: 'range outside file',
      sections: [{ path: 'src/math.ts', label: 'too far', start: 1, end: 10 }],
    },
    {
      label: 'empty range',
      sections: [{ path: 'src/math.ts', label: 'empty', start: 5, end: 4 }],
    },
    {
      label: 'overlapping sections',
      sections: [
        { path: 'src/math.ts', label: 'first', start: 3, end: 5 },
        { path: 'src/math.ts', label: 'second', start: 5, end: 7 },
      ],
    },
  ])('rejects $label', ({ sections }) => {
    expect(() => applyCodeSections(makeSnapshot(), sections)).toThrow();
  });
});
