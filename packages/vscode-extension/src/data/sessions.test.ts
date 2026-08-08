import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ReviewInsights,
  type ReviewProgress,
  type ReviewSnapshot,
  type ReviewSource,
  type ReviewWorkspace,
  createReviewStore,
  hashText,
} from '@synergy/review-core';
import { describe, expect, it } from 'vitest';
import { listSessions, loadBundle, saveNote, setItemStatus } from './sessions.js';

interface Fixture {
  workspace: ReviewWorkspace;
  snapshot: ReviewSnapshot;
  insights: ReviewInsights;
  progress: ReviewProgress;
}

function makeFixture(options: {
  workspaceId: string;
  revisionId: string;
  source: ReviewSource;
  updatedAt: string;
}): Fixture {
  const { workspaceId, revisionId, source, updatedAt } = options;
  const workspace: ReviewWorkspace = {
    schemaVersion: 1,
    id: workspaceId,
    repository: { root: '/workspace/example', name: 'example' },
    source,
    currentRevisionId: revisionId,
    createdAt: updatedAt,
    updatedAt,
  };
  const snapshot: ReviewSnapshot = {
    schemaVersion: 1,
    revisionId,
    source,
    fingerprint: `fingerprint-${revisionId}`,
    createdAt: updatedAt,
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
    revisionId,
    groups: [{ id: 'group-source', label: 'Source', reviewItemIds: ['item-1'] }],
    items: [
      {
        reviewItemId: 'item-1',
        description: 'Example item.',
        confidence: 'high',
        evidencePaths: ['src/example.ts'],
      },
    ],
  };
  const progress: ReviewProgress = {
    schemaVersion: 1,
    updatedAt,
    items: { 'item-1': { status: 'needs-review' } },
  };
  return { workspace, snapshot, insights, progress };
}

function createFixtureRoot(): string {
  return mkdtempSync(join(tmpdir(), 'synergy-vscode-sessions-'));
}

function seedWorkspace(root: string, fixture: Fixture): void {
  const store = createReviewStore(root);
  store.createRevision(fixture.workspace, fixture.snapshot, fixture.insights, fixture.progress);
}

describe('listSessions', () => {
  it('lists sessions across project roots sorted by updatedAt desc', () => {
    const rootA = createFixtureRoot();
    const rootB = createFixtureRoot();

    seedWorkspace(
      rootA,
      makeFixture({
        workspaceId: 'workspace-staged',
        revisionId: 'rev-1',
        source: { kind: 'staged', headSha: 'a' },
        updatedAt: '2026-01-01T00:00:00.000Z',
      }),
    );
    seedWorkspace(
      rootB,
      makeFixture({
        workspaceId: 'workspace-pr',
        revisionId: 'rev-1',
        source: {
          kind: 'pr',
          number: 317,
          url: 'https://example.com/pr/317',
          baseSha: 'b',
          headSha: 'c',
        },
        updatedAt: '2026-02-01T00:00:00.000Z',
      }),
    );

    const sessions = listSessions([rootA, rootB]);

    expect(sessions).toHaveLength(2);
    expect(sessions[0]?.subject).toBe('PR #317');
    expect(sessions[0]?.updatedAt).toBe('2026-02-01T00:00:00.000Z');
    expect(sessions[1]?.subject).toBe('Staged changes');
    expect(sessions[0]?.itemCount).toBe(1);
    expect(sessions[0]?.reviewedCount).toBe(0);
  });

  it('labels unstaged and scope sources', () => {
    const root = createFixtureRoot();
    seedWorkspace(
      root,
      makeFixture({
        workspaceId: 'workspace-unstaged',
        revisionId: 'rev-1',
        source: { kind: 'unstaged', headSha: 'a' },
        updatedAt: '2026-01-01T00:00:00.000Z',
      }),
    );
    seedWorkspace(
      root,
      makeFixture({
        workspaceId: 'workspace-scope',
        revisionId: 'rev-1',
        source: { kind: 'scope', patterns: ['src/**', 'lib/**'], headSha: 'a' },
        updatedAt: '2026-01-02T00:00:00.000Z',
      }),
    );

    const sessions = listSessions([root]);
    const bySubject = sessions.map((session) => session.subject);
    expect(bySubject).toContain('Unstaged changes');
    expect(bySubject).toContain('Scope: src/**, lib/**');
  });

  it('returns a degraded entry for a corrupt workspace.json', () => {
    const root = createFixtureRoot();
    seedWorkspace(
      root,
      makeFixture({
        workspaceId: 'workspace-corrupt',
        revisionId: 'rev-1',
        source: { kind: 'staged', headSha: 'a' },
        updatedAt: '2026-01-01T00:00:00.000Z',
      }),
    );
    writeFileSync(
      join(root, '.synergy', 'reviews', 'workspace-corrupt', 'workspace.json'),
      '{ not valid json',
    );

    const sessions = listSessions([root]);

    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.workspaceId).toBe('workspace-corrupt');
    expect(sessions[0]?.degraded).toBeTruthy();
  });

  it('does not let a corrupt workspace break sibling sessions', () => {
    const root = createFixtureRoot();
    seedWorkspace(
      root,
      makeFixture({
        workspaceId: 'workspace-good',
        revisionId: 'rev-1',
        source: { kind: 'staged', headSha: 'a' },
        updatedAt: '2026-01-01T00:00:00.000Z',
      }),
    );
    seedWorkspace(
      root,
      makeFixture({
        workspaceId: 'workspace-bad',
        revisionId: 'rev-1',
        source: { kind: 'staged', headSha: 'a' },
        updatedAt: '2026-01-01T00:00:00.000Z',
      }),
    );
    writeFileSync(
      join(root, '.synergy', 'reviews', 'workspace-bad', 'workspace.json'),
      '{ not valid json',
    );

    const sessions = listSessions([root]);
    const good = sessions.find((session) => session.workspaceId === 'workspace-good');
    const bad = sessions.find((session) => session.workspaceId === 'workspace-bad');
    expect(good?.degraded).toBeUndefined();
    expect(bad?.degraded).toBeTruthy();
  });

  it('returns an empty list for a root with no .synergy directory', () => {
    const root = createFixtureRoot();
    expect(listSessions([root])).toEqual([]);
  });
});

describe('loadBundle / setItemStatus / saveNote', () => {
  it('persists item status via review-core and reloads it', () => {
    const root = createFixtureRoot();
    const fixture = makeFixture({
      workspaceId: 'workspace-status',
      revisionId: 'rev-1',
      source: { kind: 'staged', headSha: 'a' },
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    seedWorkspace(root, fixture);
    const ref = { workspaceId: fixture.workspace.id, revisionId: fixture.snapshot.revisionId };

    setItemStatus(root, ref, 'item-1', 'reviewed');

    const bundle = loadBundle(root, ref);
    expect(bundle.progress.items['item-1']?.status).toBe('reviewed');
  });

  it('round-trips a saved note', () => {
    const root = createFixtureRoot();
    const fixture = makeFixture({
      workspaceId: 'workspace-note',
      revisionId: 'rev-1',
      source: { kind: 'staged', headSha: 'a' },
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    seedWorkspace(root, fixture);
    const ref = { workspaceId: fixture.workspace.id, revisionId: fixture.snapshot.revisionId };

    saveNote(root, ref, 'item-1', 'Looks fine, but double check the edge case.');

    const bundle = loadBundle(root, ref);
    expect(bundle.progress.items['item-1']?.note).toBe(
      'Looks fine, but double check the edge case.',
    );
  });
});
