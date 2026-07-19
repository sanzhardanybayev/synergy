import { describe, expect, it } from 'vitest';
import { resolveBrowserReviewItemContext } from '../src/browser.js';
import {
  applyCodeSections,
  buildDiffSnapshot,
  buildScopeSnapshot,
  resolveReviewItemContext,
  resolveReviewLineSelection,
} from '../src/index.js';

const SOURCE = { kind: 'staged' as const, headSha: 'abc123' };

describe('canonical review line rows', () => {
  it('assigns stable unique row ids to context, replacement, and deletion-only diff rows', () => {
    const patch = [
      'diff --git a/src/example.ts b/src/example.ts',
      '--- a/src/example.ts',
      '+++ b/src/example.ts',
      '@@ -1,3 +1,3 @@',
      ' context',
      '-before',
      '+after',
      ' tail',
      '@@ -10,2 +10,0 @@',
      '-gone one',
      '-gone two',
    ].join('\n');
    const snapshot = buildDiffSnapshot({
      revisionId: 'revision-a',
      source: SOURCE,
      fingerprint: 'fingerprint-a',
      createdAt: '2026-07-19T10:00:00.000Z',
      patch,
    });

    const first = resolveReviewItemContext(snapshot, snapshot.items[0]!.id);
    const repeated = resolveReviewItemContext(snapshot, snapshot.items[0]!.id);
    const deletion = resolveReviewItemContext(snapshot, snapshot.items[1]!.id);

    expect(first.rows.map((row) => row.kind)).toEqual(['context', 'remove', 'add', 'context']);
    expect(new Set(first.rows.map((row) => row.id)).size).toBe(first.rows.length);
    expect(repeated.rows.map((row) => row.id)).toEqual(first.rows.map((row) => row.id));
    expect(deletion.rows.map((row) => row.kind)).toEqual(['remove', 'remove']);
    expect(deletion.rows.every((row) => row.kind === 'remove' && row.newLine === null)).toBe(true);
    expect(new Set([...first.rows, ...deletion.rows].map((row) => row.id)).size).toBe(
      first.rows.length + deletion.rows.length,
    );
  });

  it('resolves exact diff row ids without requiring a contiguous new-line range', () => {
    const snapshot = buildDiffSnapshot({
      revisionId: 'revision-a',
      source: SOURCE,
      fingerprint: 'fingerprint-a',
      createdAt: '2026-07-19T10:00:00.000Z',
      patch: [
        'diff --git a/src/example.ts b/src/example.ts',
        '--- a/src/example.ts',
        '+++ b/src/example.ts',
        '@@ -1 +1 @@',
        '-before',
        '+after',
      ].join('\n'),
    });
    const context = resolveReviewItemContext(snapshot, snapshot.items[0]!.id);
    const selectedLineIds = context.rows.map((row) => row.id);

    expect(resolveReviewLineSelection(snapshot, snapshot.items[0]!.id, selectedLineIds)).toEqual({
      kind: 'diff',
      selectedLineIds,
    });
    expect(() =>
      resolveReviewLineSelection(snapshot, snapshot.items[0]!.id, ['row-unknown']),
    ).toThrow(/unknown review row/i);
  });

  it('keeps browser row contexts identical to server rows and rejects a tampered hunk link', () => {
    const snapshot = buildDiffSnapshot({
      revisionId: 'revision-a',
      source: SOURCE,
      fingerprint: 'fingerprint-a',
      createdAt: '2026-07-19T10:00:00.000Z',
      patch: [
        'diff --git a/src/example.ts b/src/example.ts',
        '--- a/src/example.ts',
        '+++ b/src/example.ts',
        '@@ -1 +1 @@',
        '-before',
        '+after',
      ].join('\n'),
    });
    const item = snapshot.items[0]!;
    expect(resolveBrowserReviewItemContext(snapshot, item.id)).toEqual(
      resolveReviewItemContext(snapshot, item.id),
    );
    snapshot.files[0]!.hunks[0]!.reviewItemContentHash = 'tampered';
    expect(() => resolveBrowserReviewItemContext(snapshot, item.id)).toThrow(/unavailable/i);
  });

  it('resolves each repeated semantic hunk through its unique browser relationship', () => {
    const snapshot = buildDiffSnapshot({
      revisionId: 'revision-repeated',
      source: SOURCE,
      fingerprint: 'fingerprint-repeated',
      createdAt: '2026-07-19T10:00:00.000Z',
      patch: [
        'diff --git a/src/repeated.ts b/src/repeated.ts',
        '--- a/src/repeated.ts',
        '+++ b/src/repeated.ts',
        '@@ -1 +1 @@',
        '-before',
        '+after',
        '@@ -11 +11 @@',
        '-before',
        '+after',
      ].join('\n'),
    });

    const contexts = snapshot.items.map((item) =>
      resolveBrowserReviewItemContext(snapshot, item.id),
    );
    expect(contexts.map((context) => context.item.range.start)).toEqual([1, 11]);
    expect(contexts.map((context) => context.rows[1])).toMatchObject([
      { kind: 'add', newLine: 1, text: 'after' },
      { kind: 'add', newLine: 11, text: 'after' },
    ]);
    expect(contexts).toEqual(
      snapshot.items.map((item) => resolveReviewItemContext(snapshot, item.id)),
    );

    snapshot.files[0]!.hunks[1]!.reviewItemId = snapshot.items[0]!.id;
    expect(() => resolveBrowserReviewItemContext(snapshot, snapshot.items[1]!.id)).toThrow(
      /unavailable/i,
    );
  });

  it('exposes file-level context without manufacturing selectable rows', () => {
    const snapshot = buildDiffSnapshot({
      revisionId: 'revision-binary',
      source: SOURCE,
      fingerprint: 'fingerprint-binary',
      createdAt: '2026-07-19T10:00:00.000Z',
      patch: [
        'diff --git a/assets/logo.png b/assets/logo.png',
        'Binary files a/assets/logo.png and b/assets/logo.png differ',
      ].join('\n'),
    });
    const item = snapshot.items[0]!;

    expect(item.kind).toBe('file');
    expect(resolveReviewItemContext(snapshot, item.id)).toEqual({ item, rows: [] });
    expect(resolveBrowserReviewItemContext(snapshot, item.id)).toEqual({ item, rows: [] });
    expect(() => resolveReviewLineSelection(snapshot, item.id, [])).toThrow(/unique row ids/i);
    expect(() => resolveReviewLineSelection(snapshot, item.id, ['invented-row'])).toThrow(
      /unknown review row/i,
    );

    snapshot.files[0]!.reviewItemId = 'file-tampered';
    expect(() => resolveBrowserReviewItemContext(snapshot, item.id)).toThrow(/unavailable/i);
  });

  it('builds canonical scope rows for the exact code section', () => {
    const pending = buildScopeSnapshot({
      revisionId: 'revision-a',
      source: { kind: 'scope', patterns: ['src'], headSha: 'abc123' },
      fingerprint: 'fingerprint-a',
      createdAt: '2026-07-19T10:00:00.000Z',
      files: [
        {
          path: 'src/example.ts',
          binary: false,
          lines: [
            { number: 1, text: 'before' },
            { number: 2, text: 'selected one' },
            { number: 3, text: 'selected two' },
            { number: 4, text: 'after' },
          ],
        },
      ],
    });
    const snapshot = applyCodeSections(pending, [
      { path: 'src/example.ts', label: 'selected', start: 2, end: 3 },
    ]);
    const context = resolveReviewItemContext(snapshot, snapshot.items[0]!.id);

    expect(context.rows).toMatchObject([
      { kind: 'scope', line: 2, text: 'selected one' },
      { kind: 'scope', line: 3, text: 'selected two' },
    ]);
    expect(
      resolveReviewLineSelection(snapshot, snapshot.items[0]!.id, [context.rows[1]!.id]),
    ).toEqual({ kind: 'scope', selectedLineIds: [context.rows[1]!.id] });
    expect(context.item).toEqual(snapshot.items[0]);
  });
});
