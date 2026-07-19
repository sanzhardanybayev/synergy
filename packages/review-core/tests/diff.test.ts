import { describe, expect, it } from 'vitest';
import {
  type ReviewSource,
  assertReviewSnapshot,
  buildDiffSnapshot,
  createHunkReviewItem,
  parseUnifiedDiff,
} from '../src/index.js';

const STAGED_SOURCE: ReviewSource = { kind: 'staged', headSha: 'abc1234' };

const FIXTURE_PATCH = [
  'diff --git a/src/add.ts b/src/add.ts',
  'index 1111111..2222222 100644',
  '--- a/src/add.ts',
  '+++ b/src/add.ts',
  '@@ -3,3 +3,4 @@ export function add(a: number, b: number) {',
  ' export const before = true;',
  '-export const removed = true;',
  '+export const added = true;',
  '+export const another = true;',
  ' return a + b;',
  '@@ -12 +13 @@ export function subtract(a: number, b: number) {',
  '-  return a - b;',
  '+  return a - b - 1;',
].join('\n');

const RENAME_AND_BINARY_PATCH = [
  'diff --git a/src/old.ts b/src/new.ts',
  'similarity index 100%',
  'rename from src/old.ts',
  'rename to src/new.ts',
  'diff --git a/assets/logo.png b/assets/logo.png',
  'index 1111111..2222222 100644',
  'Binary files a/assets/logo.png and b/assets/logo.png differ',
].join('\n');

const REPEATED_IDENTICAL_HUNK_PATCH = [
  'diff --git a/src/repeated.ts b/src/repeated.ts',
  '--- a/src/repeated.ts',
  '+++ b/src/repeated.ts',
  '@@ -1 +1 @@',
  '-before',
  '+after',
  '@@ -11 +11 @@',
  '-before',
  '+after',
].join('\n');

const GIT_QUOTED_PATH_CASES = [
  { label: 'tab', encoded: String.raw`src/tab\tname.ts`, decoded: 'src/tab\tname.ts' },
  { label: 'newline', encoded: String.raw`src/newline\nname.ts`, decoded: 'src/newline\nname.ts' },
  { label: 'UTF-8 octal bytes', encoded: String.raw`src/caf\303\251.ts`, decoded: 'src/café.ts' },
  { label: 'quote', encoded: String.raw`src/quote\"name.ts`, decoded: 'src/quote"name.ts' },
  {
    label: 'literal backslash',
    encoded: String.raw`src/backslash\\name.ts`,
    decoded: String.raw`src/backslash\name.ts`,
  },
] as const;

describe('unified diff parsing', () => {
  it('parses multiple hunks with stable line identities', () => {
    const files = parseUnifiedDiff(FIXTURE_PATCH);

    expect(files[0]).toMatchObject({
      path: 'src/add.ts',
      status: 'modified',
      additions: 3,
      deletions: 2,
    });
    expect(files[0]?.hunks).toHaveLength(2);
    expect(files[0]?.hunks[0]?.lines[1]).toMatchObject({
      kind: 'remove',
      oldLine: 4,
      newLine: null,
    });
    expect(files[0]?.hunks[0]?.lines[2]).toMatchObject({
      kind: 'add',
      oldLine: null,
      newLine: 4,
    });
  });

  it('preserves rename and binary metadata without inventing text items', () => {
    const files = parseUnifiedDiff(RENAME_AND_BINARY_PATCH);

    expect(files[0]).toMatchObject({
      path: 'src/new.ts',
      previousPath: 'src/old.ts',
      status: 'renamed',
      binary: false,
    });
    expect(files[0]?.hunks).toEqual([]);
    expect(files[1]).toMatchObject({
      path: 'assets/logo.png',
      status: 'binary',
      binary: true,
    });
    expect(files[1]?.hunks).toEqual([]);
  });

  it('creates honest file-level review items for every zero-hunk diff file', () => {
    const patch = [
      RENAME_AND_BINARY_PATCH,
      'diff --git a/src/mode.ts b/src/mode.ts',
      'old mode 100644',
      'new mode 100755',
      'diff --git a/src/empty-added.ts b/src/empty-added.ts',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/src/empty-added.ts',
      'diff --git a/src/empty-deleted.ts b/src/empty-deleted.ts',
      'deleted file mode 100644',
      '--- a/src/empty-deleted.ts',
      '+++ /dev/null',
    ].join('\n');

    const snapshot = buildDiffSnapshot({
      revisionId: 'patch-file-level',
      source: STAGED_SOURCE,
      fingerprint: 'file-level-fingerprint',
      createdAt: '2026-07-19T10:00:00.000Z',
      patch,
    });

    expect(snapshot.items).toHaveLength(5);
    expect(snapshot.items.map((item) => [item.path, item.kind, item.label])).toEqual([
      ['src/new.ts', 'file', 'File renamed'],
      ['assets/logo.png', 'file', 'Binary file changed'],
      ['src/mode.ts', 'file', 'File mode changed'],
      ['src/empty-added.ts', 'file', 'Empty file added'],
      ['src/empty-deleted.ts', 'file', 'Empty file deleted'],
    ]);
    expect(snapshot.files[2]).toMatchObject({ oldMode: '100644', newMode: '100755' });
    expect(snapshot.files[1]!.binaryPatchHash).toHaveLength(64);
    expect(snapshot.files.every((file) => file.reviewItemId)).toBe(true);
    expect(new Set(snapshot.items.map((item) => item.id)).size).toBe(5);
    expect(() => assertReviewSnapshot(snapshot)).not.toThrow();
    snapshot.files[1]!.binaryPatchHash = undefined;
    expect(() => assertReviewSnapshot(snapshot)).toThrow(/canonical patch hash/i);
  });

  it('parses Git-quoted repository-relative paths', () => {
    const [file] = parseUnifiedDiff(
      [
        'diff --git "a/src/space name.ts" "b/src/space name.ts"',
        '--- "a/src/space name.ts"',
        '+++ "b/src/space name.ts"',
        '@@ -1 +1 @@',
        '-before',
        '+after',
      ].join('\n'),
    );

    expect(file).toMatchObject({ path: 'src/space name.ts', additions: 1, deletions: 1 });
  });

  it('decodes Git-quoted rename metadata', () => {
    const [file] = parseUnifiedDiff(
      [
        'diff --git "a/src/old name.ts" "b/src/new name.ts"',
        'similarity index 100%',
        'rename from "src/old name.ts"',
        'rename to "src/new name.ts"',
      ].join('\n'),
    );

    expect(file).toMatchObject({
      path: 'src/new name.ts',
      previousPath: 'src/old name.ts',
      status: 'renamed',
    });
  });

  it.each(GIT_QUOTED_PATH_CASES)(
    'decodes Git C-style $label escapes before validating quoted paths',
    ({ encoded, decoded }) => {
      const [file] = parseUnifiedDiff(
        [
          `diff --git "a/${encoded}" "b/${encoded}"`,
          `--- "a/${encoded}"`,
          `+++ "b/${encoded}"`,
          '@@ -1 +1 @@',
          '-before',
          '+after',
        ].join('\n'),
      );

      expect(file?.path).toBe(decoded);
    },
  );

  it('normalizes CRLF input and records no-final-newline markers on the preceding line', () => {
    const [file] = parseUnifiedDiff(
      'diff --git a/src/example.ts b/src/example.ts\r\n' +
        '--- a/src/example.ts\r\n' +
        '+++ b/src/example.ts\r\n' +
        '@@ -1 +1 @@\r\n' +
        '-before\r\n' +
        '\\ No newline at end of file\r\n' +
        '+after\r\n' +
        '\\ No newline at end of file\r\n',
    );

    expect(file?.hunks[0]?.lines).toEqual([
      { kind: 'remove', text: 'before', oldLine: 1, newLine: null, noNewlineAtEnd: true },
      { kind: 'add', text: 'after', oldLine: null, newLine: 1, noNewlineAtEnd: true },
    ]);
  });

  it('uses normalized content and structural context, rather than line offsets, for hunk identities', () => {
    const [originalFile] = parseUnifiedDiff(FIXTURE_PATCH);
    const [shiftedFile] = parseUnifiedDiff(
      FIXTURE_PATCH.replace('@@ -3,3 +3,4 @@', '@@ -103,3 +103,4 @@').replace(
        '@@ -12 +13 @@',
        '@@ -112 +113 @@',
      ),
    );

    const original = createHunkReviewItem('src/add.ts', originalFile!.hunks[0]!);
    const shifted = createHunkReviewItem('src/add.ts', shiftedFile!.hunks[0]!);

    expect(shifted).toMatchObject({ id: original.id, contentHash: original.contentHash });
    expect(shifted.locationHash).toBe(original.locationHash);
    expect(shifted.range).not.toEqual(original.range);
  });

  it('builds review items for text hunks and zero-hunk files while preserving metadata', () => {
    const snapshot = buildDiffSnapshot({
      revisionId: 'patch-abc1234',
      source: STAGED_SOURCE,
      fingerprint: 'fingerprint',
      createdAt: '2026-07-19T10:00:00.000Z',
      patch: `${FIXTURE_PATCH}\n${RENAME_AND_BINARY_PATCH}`,
    });

    expect(snapshot).toMatchObject({
      kind: 'diff',
      revisionId: 'patch-abc1234',
      source: STAGED_SOURCE,
      fingerprint: 'fingerprint',
    });
    const hunkItems = snapshot.items.filter((item) => item.kind === 'hunk');
    const fileItems = snapshot.items.filter((item) => item.kind === 'file');
    expect(snapshot.items).toHaveLength(4);
    expect(hunkItems).toHaveLength(2);
    expect(fileItems.map((item) => item.path)).toEqual(['src/new.ts', 'assets/logo.png']);
    expect(snapshot.files.flatMap((file) => file.hunks).map((hunk) => hunk.reviewItemId)).toEqual(
      hunkItems.map((item) => item.id),
    );
    expect(snapshot.files.find((file) => file.binary)?.hunks).toEqual([]);
  });

  it('disambiguates only repeated semantic hunks with deterministic captured ranges', () => {
    const snapshot = buildDiffSnapshot({
      revisionId: 'patch-repeated',
      source: STAGED_SOURCE,
      fingerprint: 'repeated-fingerprint',
      createdAt: '2026-07-19T10:00:00.000Z',
      patch: REPEATED_IDENTICAL_HUNK_PATCH,
    });
    const parsed = parseUnifiedDiff(REPEATED_IDENTICAL_HUNK_PATCH);
    const semanticItem = createHunkReviewItem('src/repeated.ts', parsed[0]!.hunks[0]!);
    const singleSnapshot = buildDiffSnapshot({
      revisionId: 'patch-single',
      source: STAGED_SOURCE,
      fingerprint: 'single-fingerprint',
      createdAt: '2026-07-19T10:00:00.000Z',
      patch: REPEATED_IDENTICAL_HUNK_PATCH.replace(
        ['@@ -11 +11 @@', '-before', '+after'].join('\n'),
        '',
      ),
    });

    expect(snapshot.items).toHaveLength(2);
    expect(new Set(snapshot.items.map((item) => item.id)).size).toBe(2);
    expect(snapshot.items.every((item) => item.id.startsWith(`${semanticItem.id}-`))).toBe(true);
    expect(snapshot.files[0]!.hunks.map((hunk) => hunk.reviewItemId)).toEqual(
      snapshot.items.map((item) => item.id),
    );
    expect(singleSnapshot.items[0]!.id).toBe(semanticItem.id);
    expect(() => assertReviewSnapshot(snapshot)).not.toThrow();
  });

  it('rejects snapshots whose review item ids are not unique', () => {
    const snapshot = buildDiffSnapshot({
      revisionId: 'patch-duplicate-id',
      source: STAGED_SOURCE,
      fingerprint: 'duplicate-fingerprint',
      createdAt: '2026-07-19T10:00:00.000Z',
      patch: FIXTURE_PATCH,
    });
    snapshot.items[1] = { ...snapshot.items[1]!, id: snapshot.items[0]!.id };

    expect(() => assertReviewSnapshot(snapshot)).toThrow(/duplicate review item id/i);
  });

  it('maps a deletion-only hunk at file start to a schema-valid review-item range', () => {
    const snapshot = buildDiffSnapshot({
      revisionId: 'patch-delete-only',
      source: STAGED_SOURCE,
      fingerprint: 'delete-fingerprint',
      createdAt: '2026-07-19T10:00:00.000Z',
      patch: [
        'diff --git a/src/removed.ts b/src/removed.ts',
        'deleted file mode 100644',
        '--- a/src/removed.ts',
        '+++ /dev/null',
        '@@ -1 +0,0 @@',
        '-export const removed = true;',
      ].join('\n'),
    });

    expect(snapshot.items[0]?.range).toEqual({ start: 1, end: 1 });
    expect(() => assertReviewSnapshot(snapshot)).not.toThrow();
  });
});
