import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DiffReviewSnapshot, ScopeReviewSnapshot } from '@synergy/review-core';
import { hashText } from '@synergy/review-core';
import { afterEach, describe, expect, it } from 'vitest';
import { fileDrift, fileDriftOnDisk } from './drift.js';

const roots: string[] = [];
function createRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'synergy-vscode-drift-'));
  roots.push(root);
  return root;
}
afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

function scopeSnapshot(text: string): ScopeReviewSnapshot {
  const lines = text.split('\n').map((lineText, index) => ({ number: index + 1, text: lineText }));
  return {
    schemaVersion: 1,
    revisionId: 'rev-1',
    source: { kind: 'staged', headSha: 'a' },
    fingerprint: 'fp',
    createdAt: '2026-01-01T00:00:00.000Z',
    kind: 'scope',
    files: [{ path: 'src/example.ts', binary: false, lines }],
    items: [
      {
        id: 'item-1',
        kind: 'code-section',
        path: 'src/example.ts',
        label: 'src/example.ts:1',
        range: { start: 1, end: lines.length },
        contentHash: hashText(text),
        locationHash: 'loc-1',
      },
    ],
  };
}

function diffSnapshot(): DiffReviewSnapshot {
  return {
    schemaVersion: 1,
    revisionId: 'rev-1',
    source: { kind: 'staged', headSha: 'a' },
    fingerprint: 'fp',
    createdAt: '2026-01-01T00:00:00.000Z',
    kind: 'diff',
    files: [
      {
        path: 'src/example.ts',
        status: 'modified',
        additions: 1,
        deletions: 1,
        binary: false,
        hunks: [
          {
            reviewItemId: 'item-1',
            reviewItemContentHash: 'content-hash-1',
            reviewItemLocationHash: 'loc-1',
            header: '@@ -1 +1 @@',
            oldStart: 1,
            oldLines: 1,
            newStart: 1,
            newLines: 1,
            lines: [{ kind: 'add', text: 'export const value = 2;', oldLine: null, newLine: 1 }],
          },
        ],
      },
    ],
    items: [
      {
        id: 'item-1',
        kind: 'hunk',
        path: 'src/example.ts',
        label: '@@ -1 +1 @@',
        range: { start: 1, end: 1 },
        contentHash: 'content-hash-1',
        locationHash: 'loc-1',
      },
    ],
  };
}

function diffFileKindSnapshot(): DiffReviewSnapshot {
  return {
    schemaVersion: 1,
    revisionId: 'rev-1',
    source: { kind: 'staged', headSha: 'a' },
    fingerprint: 'fp',
    createdAt: '2026-01-01T00:00:00.000Z',
    kind: 'diff',
    files: [
      {
        path: 'src/renamed.ts',
        previousPath: 'src/old-name.ts',
        status: 'renamed',
        additions: 0,
        deletions: 0,
        binary: false,
        hunks: [],
        reviewItemId: 'item-file-1',
        reviewItemContentHash: 'file-content-hash-1',
        reviewItemLocationHash: 'file-loc-1',
      },
    ],
    items: [
      {
        id: 'item-file-1',
        kind: 'file',
        path: 'src/renamed.ts',
        label: 'src/renamed.ts (renamed)',
        range: { start: 0, end: 0 },
        contentHash: 'file-content-hash-1',
        locationHash: 'file-loc-1',
      },
    ],
  };
}

describe('fileDrift (pure)', () => {
  it('is clean when scope-captured text matches current text exactly', () => {
    const snapshot = scopeSnapshot('export const example = true;');
    expect(fileDrift('export const example = true;', snapshot, 'src/example.ts')).toBe('clean');
  });

  it('is drifted when scope-captured text no longer matches', () => {
    const snapshot = scopeSnapshot('export const example = true;');
    expect(fileDrift('export const example = false;', snapshot, 'src/example.ts')).toBe('drifted');
  });

  it('is missing when current text is undefined', () => {
    const snapshot = scopeSnapshot('export const example = true;');
    expect(fileDrift(undefined, snapshot, 'src/example.ts')).toBe('missing');
  });

  it('is clean when a diff hunk add-line still matches the current file', () => {
    const snapshot = diffSnapshot();
    expect(fileDrift('export const value = 2;', snapshot, 'src/example.ts')).toBe('clean');
  });

  it('is drifted when a diff hunk add-line no longer matches the current file', () => {
    const snapshot = diffSnapshot();
    expect(fileDrift('export const value = 3;', snapshot, 'src/example.ts')).toBe('drifted');
  });

  it('is clean for a path the snapshot never captured', () => {
    const snapshot = diffSnapshot();
    expect(fileDrift('anything at all', snapshot, 'src/unrelated.ts')).toBe('clean');
  });

  it('is clean for a diff file-kind item with no textual hunk rows (e.g. a rename)', () => {
    const snapshot = diffFileKindSnapshot();
    // resolveBrowserReviewItemContext resolves this item to zero rows; there is nothing to
    // compare against the current text, so this must report 'clean', not 'drifted'.
    expect(fileDrift('anything at all', snapshot, 'src/renamed.ts')).toBe('clean');
  });

  it('is clean when a scope-captured CRLF file is read back with CRLF endings intact', () => {
    const snapshot = scopeSnapshot('line one\nline two\nline three');
    const currentText = 'line one\r\nline two\r\nline three';
    expect(fileDrift(currentText, snapshot, 'src/example.ts')).toBe('clean');
  });

  it('is clean when a diff hunk add-line is read back with CRLF endings intact', () => {
    const snapshot = diffSnapshot();
    const currentText = 'export const value = 2;\r\nexport const other = 1;';
    expect(fileDrift(currentText, snapshot, 'src/example.ts')).toBe('clean');
  });
});

describe('fileDriftOnDisk', () => {
  it('reads the file relative to the project root and reports missing when absent', () => {
    const root = createRoot();
    const snapshot = scopeSnapshot('export const example = true;');
    expect(fileDriftOnDisk(root, snapshot, 'src/example.ts')).toBe('missing');
  });

  it('reports clean for an on-disk file matching the capture', () => {
    const root = createRoot();
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'example.ts'), 'export const example = true;');
    expect(
      fileDriftOnDisk(root, scopeSnapshot('export const example = true;'), 'src/example.ts'),
    ).toBe('clean');
  });

  it('reports drifted for an on-disk file edited since capture', () => {
    const root = createRoot();
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'example.ts'), 'export const example = false;');
    expect(
      fileDriftOnDisk(root, scopeSnapshot('export const example = true;'), 'src/example.ts'),
    ).toBe('drifted');
  });

  it('reports clean for an on-disk CRLF file whose content is otherwise unchanged', () => {
    const root = createRoot();
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'example.ts'), 'line one\r\nline two\r\nline three');
    expect(
      fileDriftOnDisk(root, scopeSnapshot('line one\nline two\nline three'), 'src/example.ts'),
    ).toBe('clean');
  });
});
