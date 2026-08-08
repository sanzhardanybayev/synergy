import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ReviewBundle,
  type ReviewInsights,
  type ReviewProgress,
  type ReviewSnapshot,
  type ReviewWorkspace,
  hashText,
} from '@synergy/review-core';
import { describe, expect, it } from 'vitest';
import { serializeBundle } from './serialize.js';

function makeBundle(): ReviewBundle {
  const source = { kind: 'staged' as const, headSha: 'a' };
  const workspace: ReviewWorkspace = {
    schemaVersion: 1,
    id: 'workspace-1',
    repository: { root: '/workspace/example', name: 'example' },
    source,
    currentRevisionId: 'rev-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const snapshot: ReviewSnapshot = {
    schemaVersion: 1,
    revisionId: 'rev-1',
    source,
    fingerprint: 'fingerprint-rev-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    kind: 'scope',
    files: [
      {
        path: 'src/example.ts',
        binary: false,
        lines: [{ number: 1, text: 'export const example = true;' }],
      },
    ],
    items: [
      {
        id: 'item-1',
        kind: 'code-section',
        path: 'src/example.ts',
        label: 'src/example.ts:1',
        range: { start: 1, end: 1 },
        contentHash: hashText('export const example = true;'),
        locationHash: 'location-hash-1',
      },
    ],
  };
  const insights: ReviewInsights = {
    schemaVersion: 1,
    revisionId: 'rev-1',
    groups: [{ id: 'group-source', label: 'Source', reviewItemIds: ['item-1'] }],
    items: [
      {
        reviewItemId: 'item-1',
        description: 'Example item.',
        confidence: 'high',
        evidencePaths: ['src/example.ts'],
      },
    ],
    files: [{ path: 'src/example.ts', description: 'Example file.', confidence: 'high' }],
  };
  const progress: ReviewProgress = {
    schemaVersion: 1,
    updatedAt: '2026-01-01T00:00:00.000Z',
    items: { 'item-1': { status: 'needs-review' } },
  };
  return {
    workspace,
    snapshot,
    insights,
    progress,
    questions: [],
    answers: [],
    sourceChanged: false,
  };
}

describe('serializeBundle', () => {
  it('carries the bundle and project root through unchanged', () => {
    const root = mkdtempSync(join(tmpdir(), 'synergy-vscode-serialize-'));
    const bundle = makeBundle();

    const serialized = serializeBundle(root, bundle);

    expect(serialized.bundle).toBe(bundle);
    expect(serialized.projectRoot).toBe(root);
  });

  it('reports clean drift when the file on disk matches the captured snapshot', () => {
    const root = mkdtempSync(join(tmpdir(), 'synergy-vscode-serialize-'));
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src/example.ts'), 'export const example = true;');
    const bundle = makeBundle();

    const serialized = serializeBundle(root, bundle);

    expect(serialized.drift['src/example.ts']).toBe('clean');
  });

  it('reports missing drift when the file no longer exists on disk', () => {
    const root = mkdtempSync(join(tmpdir(), 'synergy-vscode-serialize-'));
    const bundle = makeBundle();

    const serialized = serializeBundle(root, bundle);

    expect(serialized.drift['src/example.ts']).toBe('missing');
  });

  it('reports drifted when the file on disk has changed', () => {
    const root = mkdtempSync(join(tmpdir(), 'synergy-vscode-serialize-'));
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src/example.ts'), 'export const example = false;');
    const bundle = makeBundle();

    const serialized = serializeBundle(root, bundle);

    expect(serialized.drift['src/example.ts']).toBe('drifted');
  });

  it('computes drift for every distinct path across files and items', () => {
    const root = mkdtempSync(join(tmpdir(), 'synergy-vscode-serialize-'));
    const bundle = makeBundle();
    (bundle.snapshot.items as (typeof bundle.snapshot.items)[number][]).push({
      id: 'item-2',
      kind: 'code-section',
      path: 'src/other.ts',
      label: 'src/other.ts:1',
      range: { start: 1, end: 1 },
      contentHash: hashText('x'),
      locationHash: 'location-hash-2',
    });

    const serialized = serializeBundle(root, bundle);

    expect(Object.keys(serialized.drift).sort()).toEqual(['src/example.ts', 'src/other.ts']);
  });
});
