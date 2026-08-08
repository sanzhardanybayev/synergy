import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hashText } from '../src/hash.js';
import {
  type ReviewBundle,
  type ReviewQuestion,
  type ReviewSnapshot,
  applyCodeSections,
  buildDiffSnapshot,
  buildScopeSnapshot,
  createQuestionQueue,
  createReviewStore,
  resolveReviewItemContext,
  resolveReviewLineSelection,
} from '../src/index.js';

function reviewRevisionDirectory(root: string): string {
  return join(root, '.synergy', 'reviews', 'mobile-app-staged', 'revisions', 'patch-a82c19f');
}

function makeQuestion(overrides: Partial<ReviewQuestion> = {}): ReviewQuestion {
  const snapshot = makeReviewFixture().snapshot;
  const itemContext = resolveReviewItemContext(snapshot, 'hunk-abc');
  return {
    schemaVersion: 1,
    id: 'question-abc',
    workspaceId: 'mobile-app-staged',
    revisionId: 'patch-a82c19f',
    path: 'src/example.ts',
    reviewItemId: 'hunk-abc',
    selection: resolveReviewLineSelection(snapshot, 'hunk-abc', [itemContext.rows[0]!.id]),
    itemContext,
    description: 'Adds the staged example.',
    body: 'What does this example demonstrate?',
    createdAt: '2026-07-19T10:00:00.000Z',
    status: 'queued',
    ...overrides,
  };
}

function makeReviewFixture(): ReviewBundle {
  const workspace = {
    schemaVersion: 1 as const,
    id: 'mobile-app-staged',
    repository: { root: '/workspace/mobile-app', name: 'mobile-app' },
    source: { kind: 'staged' as const, headSha: 'a82c19f' },
    currentRevisionId: 'patch-a82c19f',
    createdAt: '2026-07-19T10:00:00.000Z',
    updatedAt: '2026-07-19T10:00:00.000Z',
  };
  const snapshot = {
    schemaVersion: 1 as const,
    revisionId: 'patch-a82c19f',
    source: workspace.source,
    fingerprint: 'snapshot-fingerprint',
    createdAt: '2026-07-19T10:00:00.000Z',
    kind: 'scope' as const,
    files: [
      {
        path: 'src/example.ts',
        binary: false,
        lines: [{ number: 1, text: 'export const example = true;' }],
      },
    ],
    items: [
      {
        id: 'hunk-abc',
        kind: 'code-section' as const,
        path: 'src/example.ts',
        label: '@@ -1 +1 @@',
        range: { start: 1, end: 1 },
        contentHash: hashText('export const example = true;'),
        locationHash: 'location-hash',
      },
    ],
  };
  const insights = {
    schemaVersion: 1 as const,
    revisionId: 'patch-a82c19f',
    groups: [
      {
        id: 'group-source',
        label: 'Source',
        reviewItemIds: ['hunk-abc'],
      },
    ],
    items: [
      {
        reviewItemId: 'hunk-abc',
        description: 'Adds the staged example.',
        confidence: 'high' as const,
        evidencePaths: ['src/example.ts'],
      },
    ],
  };
  const progress = {
    schemaVersion: 1 as const,
    updatedAt: '2026-07-19T10:00:00.000Z',
    items: { 'hunk-abc': { status: 'needs-review' as const } },
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

function makeSuccessorFixture(predecessorRevisionId: string): ReviewBundle {
  const previous = makeReviewFixture();
  const revisionId = 'patch-successor';
  return {
    ...previous,
    workspace: {
      ...previous.workspace,
      currentRevisionId: revisionId,
      updatedAt: '2026-07-19T10:01:00.000Z',
    },
    snapshot: {
      ...previous.snapshot,
      revisionId,
      predecessorRevisionId,
      fingerprint: 'successor-fingerprint',
      createdAt: '2026-07-19T10:01:00.000Z',
    },
    insights: { ...previous.insights, revisionId },
    progress: { ...previous.progress, updatedAt: '2026-07-19T10:01:00.000Z' },
  };
}

describe('review storage', () => {
  it('rejects outward symlinks in existing review ancestors and final artifacts', () => {
    const root = mkdtempSync(join(tmpdir(), 'synergy-review-'));
    const outside = mkdtempSync(join(tmpdir(), 'synergy-review-outside-'));
    mkdirSync(join(root, '.synergy'), { recursive: true });
    symlinkSync(outside, join(root, '.synergy', 'reviews'));

    expect(() => createReviewStore(root).readWorkspace('mobile-app-staged')).toThrow(
      /symbolic link/i,
    );

    unlinkSync(join(root, '.synergy', 'reviews'));
    const store = createReviewStore(root);
    const fixture = makeReviewFixture();
    store.createRevision(fixture.workspace, fixture.snapshot, fixture.insights, fixture.progress);
    const workspacePath = join(root, '.synergy', 'reviews', fixture.workspace.id, 'workspace.json');
    unlinkSync(workspacePath);
    const outsideWorkspace = join(outside, 'workspace.json');
    writeFileSync(outsideWorkspace, JSON.stringify(fixture.workspace));
    symlinkSync(outsideWorkspace, workspacePath);

    expect(() => store.readWorkspace(fixture.workspace.id)).toThrow(/symbolic link/i);
  });

  it('rejects an outward revisions-directory symlink before scanning an empty target', () => {
    const root = mkdtempSync(join(tmpdir(), 'synergy-review-'));
    const outside = mkdtempSync(join(tmpdir(), 'synergy-review-empty-outside-'));
    const workspaceDirectory = join(root, '.synergy', 'reviews', 'mobile-app-staged');
    mkdirSync(workspaceDirectory, { recursive: true });
    symlinkSync(outside, join(workspaceDirectory, 'revisions'));

    expect(() =>
      createReviewStore(root).findRevisionByFingerprint('mobile-app-staged', 'fingerprint'),
    ).toThrow(/symbolic link/i);
  });

  it('recovers a dead owner lock but never steals a live owner lock', () => {
    const root = mkdtempSync(join(tmpdir(), 'synergy-review-'));
    const fixture = makeReviewFixture();
    const workspaceDirectory = join(root, '.synergy', 'reviews', fixture.workspace.id);
    mkdirSync(workspaceDirectory, { recursive: true });
    const lockPath = join(workspaceDirectory, '.review-lock');
    writeFileSync(
      lockPath,
      `${JSON.stringify({ schemaVersion: 1, pid: 999_999_999, token: 'dead-owner', createdAt: new Date().toISOString() })}\n`,
    );

    const recovering = createReviewStore(root, { isProcessAlive: () => false });
    recovering.createRevision(
      fixture.workspace,
      fixture.snapshot,
      fixture.insights,
      fixture.progress,
    );
    expect(existsSync(lockPath)).toBe(false);

    writeFileSync(
      lockPath,
      `${JSON.stringify({ schemaVersion: 1, pid: 42, token: 'live-owner', createdAt: new Date().toISOString() })}\n`,
    );
    const blocked = createReviewStore(root, { isProcessAlive: () => true });
    expect(() =>
      blocked.updateProgress(fixture.workspace.id, fixture.snapshot.revisionId, {}),
    ).toThrow(/busy/i);
    expect(readFileSync(lockPath, 'utf8')).toContain('live-owner');
  });

  it('recovers abandoned same-process locks but never steals partial lock metadata', () => {
    const root = mkdtempSync(join(tmpdir(), 'synergy-review-'));
    const fixture = makeReviewFixture();
    const workspaceDirectory = join(root, '.synergy', 'reviews', fixture.workspace.id);
    mkdirSync(workspaceDirectory, { recursive: true });
    const lockPath = join(workspaceDirectory, '.review-lock');
    writeFileSync(
      lockPath,
      `${JSON.stringify({ schemaVersion: 1, pid: process.pid, token: 'inactive-owner', createdAt: new Date().toISOString() })}\n`,
    );
    const store = createReviewStore(root);
    store.createRevision(fixture.workspace, fixture.snapshot, fixture.insights, fixture.progress);

    writeFileSync(lockPath, 'partial');
    expect(() =>
      store.updateProgress(fixture.workspace.id, fixture.snapshot.revisionId, {}),
    ).toThrow(/busy/i);
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockPath, old, old);
    expect(() =>
      store.updateProgress(fixture.workspace.id, fixture.snapshot.revisionId, {}),
    ).toThrow(/busy/i);
    expect(readFileSync(lockPath, 'utf8')).toBe('partial');
  });

  it('attempts lock unlink even when descriptor close fails', () => {
    const root = mkdtempSync(join(tmpdir(), 'synergy-review-'));
    const fixture = makeReviewFixture();
    const store = createReviewStore(root, {
      closeLockFile: () => {
        throw new Error('injected close failure');
      },
    });

    expect(() =>
      store.createRevision(fixture.workspace, fixture.snapshot, fixture.insights, fixture.progress),
    ).toThrow(/close failure/i);
    expect(
      existsSync(join(root, '.synergy', 'reviews', fixture.workspace.id, '.review-lock')),
    ).toBe(false);
  });

  it.each(['EACCES', 'ENOSPC', 'EMFILE'])(
    'does not classify %s lock-open failures as workspace contention',
    (code) => {
      const root = mkdtempSync(join(tmpdir(), 'synergy-review-'));
      const failure = Object.assign(new Error('sensitive infrastructure detail'), { code });
      const store = createReviewStore(root, {
        openLockFile: () => {
          throw failure;
        },
      });
      const fixture = makeReviewFixture();
      let thrown: unknown;
      try {
        store.createRevision(
          fixture.workspace,
          fixture.snapshot,
          fixture.insights,
          fixture.progress,
        );
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toMatchObject({ code: 'review_internal' });
      expect((thrown as Error).message).not.toContain('sensitive infrastructure detail');
    },
  );

  it('classifies only EEXIST lock-open failures as workspace contention', () => {
    const root = mkdtempSync(join(tmpdir(), 'synergy-review-'));
    const failure = Object.assign(new Error('lock exists'), { code: 'EEXIST' });
    const store = createReviewStore(root, {
      openLockFile: () => {
        throw failure;
      },
    });
    const fixture = makeReviewFixture();
    let thrown: unknown;
    try {
      store.createRevision(fixture.workspace, fixture.snapshot, fixture.insights, fixture.progress);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({ code: 'review_busy' });
  });

  it('returns typed not-found, conflict, and corrupt storage errors', () => {
    const root = mkdtempSync(join(tmpdir(), 'synergy-review-'));
    const store = createReviewStore(root);
    let missing: unknown;
    try {
      store.readWorkspace('missing-workspace');
    } catch (error) {
      missing = error;
    }
    expect(missing).toMatchObject({ code: 'review_not_found' });

    const fixture = makeReviewFixture();
    store.createRevision(fixture.workspace, fixture.snapshot, fixture.insights, fixture.progress);
    let conflict: unknown;
    try {
      store.createRevision(fixture.workspace, fixture.snapshot, fixture.insights, fixture.progress);
    } catch (error) {
      conflict = error;
    }
    expect(conflict).toMatchObject({ code: 'review_conflict' });

    writeFileSync(
      join(root, '.synergy', 'reviews', fixture.workspace.id, 'workspace.json'),
      '{malformed',
    );
    let corrupt: unknown;
    try {
      store.readWorkspace(fixture.workspace.id);
    } catch (error) {
      corrupt = error;
    }
    expect(corrupt).toMatchObject({ code: 'review_corrupt' });
  });

  it('creates an immutable revision and reads it as a bundle', () => {
    const root = mkdtempSync(join(tmpdir(), 'synergy-review-'));
    const store = createReviewStore(root);
    const fixture = makeReviewFixture();

    store.createRevision(fixture.workspace, fixture.snapshot, fixture.insights, fixture.progress);

    expect(store.readBundle('mobile-app-staged', 'patch-a82c19f')).toEqual(fixture);
    expect(() =>
      store.createRevision(fixture.workspace, fixture.snapshot, fixture.insights, fixture.progress),
    ).toThrow('revision already exists');
  });

  it('recovers an exact revision orphaned after directory publication but before workspace pointer', () => {
    const root = mkdtempSync(join(tmpdir(), 'synergy-review-'));
    const fixture = makeReviewFixture();
    let failOnce = true;
    const crashing = createReviewStore(root, {
      beforeWorkspacePublish: () => {
        if (!failOnce) return;
        failOnce = false;
        throw new Error('crash before pointer');
      },
    });

    expect(() =>
      crashing.createRevision(
        fixture.workspace,
        fixture.snapshot,
        fixture.insights,
        fixture.progress,
      ),
    ).toThrow(/crash before pointer/i);
    expect(existsSync(reviewRevisionDirectory(root))).toBe(true);
    expect(
      existsSync(join(root, '.synergy', 'reviews', fixture.workspace.id, 'workspace.json')),
    ).toBe(false);

    createReviewStore(root).createRevision(
      fixture.workspace,
      fixture.snapshot,
      fixture.insights,
      fixture.progress,
    );
    expect(
      createReviewStore(root).readBundle(fixture.workspace.id, fixture.snapshot.revisionId),
    ).toMatchObject({ snapshot: fixture.snapshot });
  });

  it('persists an immutable direct predecessor on a successor revision', () => {
    const root = mkdtempSync(join(tmpdir(), 'synergy-review-'));
    const store = createReviewStore(root);
    const previous = makeReviewFixture();
    const successor = makeSuccessorFixture(previous.snapshot.revisionId);
    store.createRevision(
      previous.workspace,
      previous.snapshot,
      previous.insights,
      previous.progress,
    );

    store.createRevision(
      successor.workspace,
      successor.snapshot,
      successor.insights,
      successor.progress,
    );

    expect(
      store.readBundle(successor.workspace.id, successor.snapshot.revisionId).snapshot
        .predecessorRevisionId,
    ).toBe(previous.snapshot.revisionId);
  });

  it('projects an exact historical revision without changing the current workspace pointer', () => {
    const root = mkdtempSync(join(tmpdir(), 'synergy-review-'));
    const store = createReviewStore(root);
    const previous = makeReviewFixture();
    const pendingInsights = { ...previous.insights, groups: [], items: [] };
    store.createRevision(previous.workspace, previous.snapshot, pendingInsights, previous.progress);
    store.writeInitialInsights(
      previous.workspace.id,
      previous.snapshot.revisionId,
      previous.insights,
    );

    const successorSource = { kind: 'staged' as const, headSha: 'successor-head' };
    const successor = makeSuccessorFixture(previous.snapshot.revisionId);
    const successorWorkspace = { ...successor.workspace, source: successorSource };
    const successorSnapshot = { ...successor.snapshot, source: successorSource };
    store.createRevision(
      successorWorkspace,
      successorSnapshot,
      successor.insights,
      successor.progress,
    );
    const currentWorkspace = store.readWorkspace(previous.workspace.id);

    const historical = store.readBundle(previous.workspace.id, previous.snapshot.revisionId);

    expect(historical.workspace).toMatchObject({
      source: previous.snapshot.source,
      currentRevisionId: previous.snapshot.revisionId,
    });
    expect(historical.snapshot).toEqual(previous.snapshot);
    expect(store.readWorkspace(previous.workspace.id)).toEqual(currentWorkspace);
    expect(currentWorkspace).toMatchObject({
      source: successorSource,
      currentRevisionId: successor.snapshot.revisionId,
    });
  });

  it('rejects a successor whose predecessor is not the current workspace revision', () => {
    const root = mkdtempSync(join(tmpdir(), 'synergy-review-'));
    const store = createReviewStore(root);
    const previous = makeReviewFixture();
    const successor = makeSuccessorFixture('forged-predecessor');
    store.createRevision(
      previous.workspace,
      previous.snapshot,
      previous.insights,
      previous.progress,
    );

    expect(() =>
      store.createRevision(
        successor.workspace,
        successor.snapshot,
        successor.insights,
        successor.progress,
      ),
    ).toThrow(/predecessor must be the current workspace revision/i);
  });

  it('updates the current revision metadata monotonically and writes an injected-clock pointer', () => {
    const root = mkdtempSync(join(tmpdir(), 'synergy-review-'));
    const now = Date.parse('2026-07-19T10:00:00.000Z');
    const store = createReviewStore(root, { now: () => now });
    const fixture = makeReviewFixture();
    store.createRevision(fixture.workspace, fixture.snapshot, fixture.insights, fixture.progress);

    store.setCurrentRevision(
      fixture.workspace.id,
      fixture.snapshot.revisionId,
      fixture.workspace.source,
    );
    const workspace = store.readWorkspace(fixture.workspace.id);
    const pointer = store.setActiveReview(fixture.workspace.id, fixture.snapshot.revisionId);

    expect(Date.parse(workspace.updatedAt)).toBeGreaterThan(
      Date.parse(fixture.workspace.updatedAt),
    );
    expect(pointer).toMatchObject({
      workspaceId: fixture.workspace.id,
      revisionId: fixture.snapshot.revisionId,
      updatedAt: fixture.workspace.updatedAt,
    });
  });

  it('finds a revision by fingerprint and permits one initial analysis write only', () => {
    const root = mkdtempSync(join(tmpdir(), 'synergy-review-'));
    const store = createReviewStore(root);
    const fixture = makeReviewFixture();
    const pendingInsights = { ...fixture.insights, groups: [], items: [] };
    store.createRevision(fixture.workspace, fixture.snapshot, pendingInsights, fixture.progress);

    expect(store.findRevisionByFingerprint('mobile-app-staged', 'snapshot-fingerprint')).toEqual(
      'patch-a82c19f',
    );
    store.writeInitialInsights('mobile-app-staged', 'patch-a82c19f', fixture.insights);
    expect(store.readBundle('mobile-app-staged', 'patch-a82c19f').insights).toEqual(
      fixture.insights,
    );
    expect(() =>
      store.writeInitialInsights('mobile-app-staged', 'patch-a82c19f', fixture.insights),
    ).toThrow(/already/i);
  });

  it('preserves an explicit finalization milestone through progress writes and reads legacy bundles', () => {
    const root = mkdtempSync(join(tmpdir(), 'synergy-review-finalized-at-'));
    const fixture = makeReviewFixture();
    const pendingInsights = { ...fixture.insights, groups: [], items: [] };
    const finalizedAt = '2026-07-19T10:03:30.000Z';
    const store = createReviewStore(root, { now: () => Date.parse(finalizedAt) });
    store.createRevision(fixture.workspace, fixture.snapshot, pendingInsights, fixture.progress);

    expect(
      store.getAnalysisFinalizedAt(fixture.workspace.id, fixture.snapshot.revisionId),
    ).toBeUndefined();
    store.writeInitialInsights(
      fixture.workspace.id,
      fixture.snapshot.revisionId,
      fixture.insights,
      finalizedAt,
    );

    expect(
      createReviewStore(root).getAnalysisFinalizedAt(
        fixture.workspace.id,
        fixture.snapshot.revisionId,
      ),
    ).toBe(finalizedAt);

    store.updateProgress(fixture.workspace.id, fixture.snapshot.revisionId, {
      activeFile: fixture.snapshot.items[0]?.path,
    });
    expect(
      createReviewStore(root).getAnalysisFinalizedAt(
        fixture.workspace.id,
        fixture.snapshot.revisionId,
      ),
    ).toBe(finalizedAt);

    const reviewItemId = fixture.snapshot.items[0]?.id;
    if (!reviewItemId) throw new Error('fixture must contain a review item');
    store.patchItemProgress(fixture.workspace.id, fixture.snapshot.revisionId, reviewItemId, {
      status: 'reviewed',
    });
    expect(
      createReviewStore(root).getAnalysisFinalizedAt(
        fixture.workspace.id,
        fixture.snapshot.revisionId,
      ),
    ).toBe(finalizedAt);

    const bundlePath = join(reviewRevisionDirectory(root), 'bundle.json');
    const legacyBundle = JSON.parse(readFileSync(bundlePath, 'utf8'));
    legacyBundle.finalizedAt = undefined;
    writeFileSync(bundlePath, JSON.stringify(legacyBundle), 'utf8');
    const legacyStore = createReviewStore(root);
    expect(
      legacyStore.getAnalysisFinalizedAt(fixture.workspace.id, fixture.snapshot.revisionId),
    ).toBeUndefined();
    expect(
      legacyStore.readBundle(fixture.workspace.id, fixture.snapshot.revisionId).insights,
    ).toEqual(fixture.insights);
  });

  it('ignores crash-residue and identity-mismatched directories during fingerprint scans', () => {
    const root = mkdtempSync(join(tmpdir(), 'synergy-review-'));
    const store = createReviewStore(root);
    const fixture = makeReviewFixture();
    const revisions = join(root, '.synergy', 'reviews', fixture.workspace.id, 'revisions');
    mkdirSync(join(revisions, 'partial.creating-dead'), { recursive: true });
    writeFileSync(
      join(revisions, 'partial.creating-dead', 'snapshot.json'),
      JSON.stringify({ ...fixture.snapshot, revisionId: 'other-revision' }),
    );
    mkdirSync(join(revisions, 'identity-mismatch'), { recursive: true });
    writeFileSync(
      join(revisions, 'identity-mismatch', 'snapshot.json'),
      JSON.stringify({ ...fixture.snapshot, revisionId: 'different-directory' }),
    );

    expect(
      store.findRevisionByFingerprint(fixture.workspace.id, fixture.snapshot.fingerprint),
    ).toBeUndefined();
  });

  it('refuses to publish a current pointer when the snapshot identity differs from its directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'synergy-review-'));
    const store = createReviewStore(root);
    const fixture = makeReviewFixture();
    store.createRevision(fixture.workspace, fixture.snapshot, fixture.insights, fixture.progress);
    const forgedRevision = 'forged-revision';
    const forgedDirectory = join(
      root,
      '.synergy',
      'reviews',
      fixture.workspace.id,
      'revisions',
      forgedRevision,
    );
    mkdirSync(forgedDirectory, { recursive: true });
    writeFileSync(join(forgedDirectory, 'snapshot.json'), JSON.stringify(fixture.snapshot));

    expect(() =>
      store.setCurrentRevision(fixture.workspace.id, forgedRevision, fixture.workspace.source),
    ).toThrow(/snapshot revision does not match requested revision/i);
    expect(store.readWorkspace(fixture.workspace.id).currentRevisionId).toBe(
      fixture.snapshot.revisionId,
    );
  });

  it('requires workspace and current-pointer sources to match the target snapshot', () => {
    const root = mkdtempSync(join(tmpdir(), 'synergy-review-'));
    const store = createReviewStore(root);
    const fixture = makeReviewFixture();
    expect(() =>
      store.createRevision(
        { ...fixture.workspace, source: { kind: 'unstaged', headSha: 'different' } },
        fixture.snapshot,
        fixture.insights,
        fixture.progress,
      ),
    ).toThrow(/source must match/i);

    store.createRevision(fixture.workspace, fixture.snapshot, fixture.insights, fixture.progress);
    expect(() =>
      store.setCurrentRevision(fixture.workspace.id, fixture.snapshot.revisionId, {
        kind: 'unstaged',
        headSha: 'different',
      }),
    ).toThrow(/source must match/i);
  });

  it('rejects carried-forward coverage without an exact carryable predecessor item', () => {
    const root = mkdtempSync(join(tmpdir(), 'synergy-review-'));
    const store = createReviewStore(root);
    const previous = makeReviewFixture();
    previous.progress.items['hunk-abc'] = {
      status: 'reviewed',
      reviewedAt: previous.progress.updatedAt,
    };
    store.createRevision(
      previous.workspace,
      previous.snapshot,
      previous.insights,
      previous.progress,
    );
    const successor = makeSuccessorFixture(previous.snapshot.revisionId);
    successor.progress.items['hunk-abc'] = {
      status: 'carried-forward',
      reviewedAt: successor.progress.updatedAt,
      inheritedFrom: {
        revisionId: previous.snapshot.revisionId,
        reviewItemId: 'missing-predecessor-item',
      },
    };

    expect(() =>
      store.createRevision(
        successor.workspace,
        successor.snapshot,
        successor.insights,
        successor.progress,
      ),
    ).toThrow(/carryable predecessor/i);
  });

  it('rejects a concurrent immutable-analysis writer while the workspace is claimed', () => {
    const root = mkdtempSync(join(tmpdir(), 'synergy-review-'));
    const store = createReviewStore(root);
    const fixture = makeReviewFixture();
    store.createRevision(
      fixture.workspace,
      fixture.snapshot,
      { ...fixture.insights, groups: [], items: [] },
      fixture.progress,
    );
    const lockPath = join(root, '.synergy', 'reviews', 'mobile-app-staged', '.review-lock');
    const descriptor = openSync(lockPath, 'wx');
    try {
      let thrown: unknown;
      try {
        store.writeInitialInsights('mobile-app-staged', 'patch-a82c19f', fixture.insights);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toMatchObject({ code: 'review_busy' });
    } finally {
      closeSync(descriptor);
      unlinkSync(lockPath);
    }
  });

  it('keeps the pending bundle coherent when finalized publication fails before rename', () => {
    const root = mkdtempSync(join(tmpdir(), 'synergy-review-'));
    const fixture = makeReviewFixture();
    const pendingInsights = { ...fixture.insights, groups: [], items: [] };
    const writer = createReviewStore(root, {
      beforeFinalizedBundlePublish: () => {
        throw new Error('injected publication failure');
      },
    });
    writer.createRevision(fixture.workspace, fixture.snapshot, pendingInsights, fixture.progress);

    expect(() =>
      writer.writeInitialInsights('mobile-app-staged', 'patch-a82c19f', fixture.insights),
    ).toThrow(/injected publication failure/);
    const reader = createReviewStore(root);
    expect(reader.readBundle('mobile-app-staged', 'patch-a82c19f')).toMatchObject({
      snapshot: fixture.snapshot,
      insights: pendingInsights,
      progress: fixture.progress,
    });
    expect(reader.isAnalysisFinalized('mobile-app-staged', 'patch-a82c19f')).toBe(false);

    reader.writeInitialInsights('mobile-app-staged', 'patch-a82c19f', fixture.insights);
    expect(reader.readBundle('mobile-app-staged', 'patch-a82c19f')).toMatchObject({
      snapshot: fixture.snapshot,
      insights: fixture.insights,
      progress: fixture.progress,
    });
  });

  it('reads a coherent pending bundle while finalization is paused before publish', () => {
    const root = mkdtempSync(join(tmpdir(), 'synergy-review-'));
    const fixture = makeReviewFixture();
    const pendingInsights = { ...fixture.insights, groups: [], items: [] };
    let observedPending = false;
    const writer = createReviewStore(root, {
      beforeFinalizedBundlePublish: () => {
        const observed = createReviewStore(root).readBundle('mobile-app-staged', 'patch-a82c19f');
        observedPending =
          observed.snapshot.items[0]?.id === 'hunk-abc' && observed.insights.items.length === 0;
      },
    });
    writer.createRevision(fixture.workspace, fixture.snapshot, pendingInsights, fixture.progress);
    writer.writeInitialInsights('mobile-app-staged', 'patch-a82c19f', fixture.insights);

    expect(observedPending).toBe(true);
    expect(createReviewStore(root).readBundle('mobile-app-staged', 'patch-a82c19f')).toMatchObject({
      snapshot: fixture.snapshot,
      insights: fixture.insights,
      progress: fixture.progress,
    });
  });

  it('merges mutable progress without changing immutable snapshot data', () => {
    const root = mkdtempSync(join(tmpdir(), 'synergy-review-'));
    const store = createReviewStore(root);
    const fixture = makeReviewFixture();
    store.createRevision(fixture.workspace, fixture.snapshot, fixture.insights, fixture.progress);

    const progress = store.updateProgress('mobile-app-staged', 'patch-a82c19f', {
      activeFile: 'src/example.ts',
      items: { 'hunk-abc': { status: 'reviewed', reviewedAt: '2026-07-19T11:00:00.000Z' } },
    });

    expect(progress).toMatchObject({
      activeFile: 'src/example.ts',
      items: { 'hunk-abc': { status: 'reviewed', reviewedAt: '2026-07-19T11:00:00.000Z' } },
    });
    expect(store.readBundle('mobile-app-staged', 'patch-a82c19f').snapshot).toEqual(
      fixture.snapshot,
    );
  });

  it('uses a strictly increasing server timestamp when the clock does not advance', () => {
    const root = mkdtempSync(join(tmpdir(), 'synergy-review-'));
    const store = createReviewStore(root, { now: () => Date.parse('2026-07-19T10:00:00.000Z') });
    const fixture = makeReviewFixture();
    store.createRevision(fixture.workspace, fixture.snapshot, fixture.insights, fixture.progress);

    const first = store.updateProgress('mobile-app-staged', 'patch-a82c19f', {
      activeFile: 'src/example.ts',
    });
    const second = store.patchItemProgress('mobile-app-staged', 'patch-a82c19f', 'hunk-abc', {
      note: 'Monotonic.',
    });

    expect(Date.parse(second.updatedAt)).toBeGreaterThan(Date.parse(first.updatedAt));
  });

  it('merges item note and status patches under the workspace lock, including explicit clear', () => {
    const root = mkdtempSync(join(tmpdir(), 'synergy-review-'));
    const store = createReviewStore(root);
    const fixture = makeReviewFixture();
    store.createRevision(fixture.workspace, fixture.snapshot, fixture.insights, fixture.progress);

    store.patchItemProgress('mobile-app-staged', 'patch-a82c19f', 'hunk-abc', {
      note: 'Preserve me.',
    });
    store.patchItemProgress('mobile-app-staged', 'patch-a82c19f', 'hunk-abc', {
      status: 'reviewed',
    });
    expect(
      store.readBundle('mobile-app-staged', 'patch-a82c19f').progress.items['hunk-abc'],
    ).toMatchObject({ status: 'reviewed', note: 'Preserve me.' });

    store.patchItemProgress('mobile-app-staged', 'patch-a82c19f', 'hunk-abc', { note: null });
    expect(
      store.readBundle('mobile-app-staged', 'patch-a82c19f').progress.items['hunk-abc'],
    ).toEqual({ status: 'reviewed', reviewedAt: expect.any(String) });
  });

  it('serializes a pending progress update before analysis finalization', () => {
    const root = mkdtempSync(join(tmpdir(), 'synergy-review-'));
    const fixture = makeReviewFixture();
    const pendingInsights = { ...fixture.insights, groups: [], items: [] };
    const finalizer = createReviewStore(root);
    const updater = createReviewStore(root, {
      beforeProgressPublish: () => {
        expect(() =>
          finalizer.writeInitialInsights('mobile-app-staged', 'patch-a82c19f', fixture.insights),
        ).toThrow(/busy/i);
      },
    });
    updater.createRevision(fixture.workspace, fixture.snapshot, pendingInsights, fixture.progress);

    updater.updateProgress('mobile-app-staged', 'patch-a82c19f', { activeFile: 'src/example.ts' });
    finalizer.writeInitialInsights('mobile-app-staged', 'patch-a82c19f', fixture.insights);

    const finalized = finalizer.readBundle('mobile-app-staged', 'patch-a82c19f');
    expect(finalized.progress.activeFile).toBe('src/example.ts');
    expect(finalizer.isAnalysisFinalized('mobile-app-staged', 'patch-a82c19f')).toBe(true);
  });

  it('serializes finalized progress updaters without losing unrelated fields', () => {
    const root = mkdtempSync(join(tmpdir(), 'synergy-review-'));
    const fixture = makeReviewFixture();
    const pendingInsights = { ...fixture.insights, groups: [], items: [] };
    const secondUpdater = createReviewStore(root);
    let attemptedConcurrentUpdate = false;
    const firstUpdater = createReviewStore(root, {
      beforeFinalizedBundlePublish: () => {
        if (attemptedConcurrentUpdate) return;
        attemptedConcurrentUpdate = true;
        expect(() =>
          secondUpdater.updateProgress('mobile-app-staged', 'patch-a82c19f', {
            items: { 'hunk-abc': { status: 'reviewed' } },
          }),
        ).toThrow(/busy/i);
      },
    });
    firstUpdater.createRevision(
      fixture.workspace,
      fixture.snapshot,
      pendingInsights,
      fixture.progress,
    );
    secondUpdater.writeInitialInsights('mobile-app-staged', 'patch-a82c19f', fixture.insights);

    firstUpdater.updateProgress('mobile-app-staged', 'patch-a82c19f', {
      activeFile: 'src/example.ts',
    });
    secondUpdater.updateProgress('mobile-app-staged', 'patch-a82c19f', {
      items: { 'hunk-abc': { status: 'reviewed' } },
    });

    expect(secondUpdater.readBundle('mobile-app-staged', 'patch-a82c19f').progress).toMatchObject({
      activeFile: 'src/example.ts',
      items: { 'hunk-abc': { status: 'reviewed' } },
    });
  });

  it('accepts a scoped finalization with reordered object keys but identical captured source', () => {
    const root = mkdtempSync(join(tmpdir(), 'synergy-review-'));
    const source = { kind: 'scope' as const, patterns: ['src'], headSha: 'abc123' };
    const pending = buildScopeSnapshot({
      revisionId: 'scope-abc123',
      source,
      fingerprint: 'scope-fingerprint',
      createdAt: '2026-07-19T10:00:00.000Z',
      files: [
        {
          path: 'src/example.ts',
          binary: false,
          lines: [{ number: 1, text: 'export const example = true;' }],
        },
      ],
    });
    const snapshot = applyCodeSections(pending, [
      { path: 'src/example.ts', label: 'example', start: 1, end: 1 },
    ]);
    const item = snapshot.items[0];
    if (!item) throw new Error('scope fixture must generate one review item');
    const reordered: ReviewSnapshot = {
      items: snapshot.items,
      files: snapshot.files,
      kind: snapshot.kind,
      createdAt: snapshot.createdAt,
      fingerprint: snapshot.fingerprint,
      source: { headSha: source.headSha, patterns: source.patterns, kind: source.kind },
      revisionId: snapshot.revisionId,
      schemaVersion: snapshot.schemaVersion,
    };
    const workspace = {
      schemaVersion: 1 as const,
      id: 'scope-workspace',
      repository: { root, name: 'review' },
      source,
      currentRevisionId: pending.revisionId,
      createdAt: pending.createdAt,
      updatedAt: pending.createdAt,
    };
    const insights = {
      schemaVersion: 1 as const,
      revisionId: pending.revisionId,
      groups: [{ id: 'scope', label: 'Scope', reviewItemIds: [item.id] }],
      items: [
        {
          reviewItemId: item.id,
          description: 'Reviews the scoped export.',
          confidence: 'high' as const,
          evidencePaths: ['src/example.ts'],
        },
      ],
    };
    const progress = {
      schemaVersion: 1 as const,
      updatedAt: pending.createdAt,
      items: { [item.id]: { status: 'needs-review' as const } },
    };
    const store = createReviewStore(root);
    store.createRevision(
      workspace,
      pending,
      { ...insights, groups: [], items: [] },
      { ...progress, items: {} },
    );

    store.finalizeScopeAnalysis(workspace.id, pending.revisionId, reordered, insights, progress);

    expect(store.readBundle(workspace.id, pending.revisionId).snapshot.items).toEqual(
      snapshot.items,
    );
  });

  it('writes JSON atomically and rejects malformed persisted artifacts', () => {
    const root = mkdtempSync(join(tmpdir(), 'synergy-review-'));
    const store = createReviewStore(root);
    const fixture = makeReviewFixture();
    store.createRevision(fixture.workspace, fixture.snapshot, fixture.insights, fixture.progress);

    const progressPath = join(reviewRevisionDirectory(root), 'progress.json');
    expect(existsSync(progressPath)).toBe(true);
    expect(readFileSync(progressPath, 'utf8')).toContain('\n');

    writeFileSync(progressPath, '{not-valid-json', 'utf8');

    let corrupt: unknown;
    try {
      store.readBundle('mobile-app-staged', 'patch-a82c19f');
    } catch (error) {
      corrupt = error;
    }
    expect(corrupt).toMatchObject({ code: 'review_corrupt' });
  });

  it('rejects a workspace artifact stored under a different workspace identity', () => {
    const root = mkdtempSync(join(tmpdir(), 'synergy-review-'));
    const store = createReviewStore(root);
    const fixture = makeReviewFixture();
    store.createRevision(fixture.workspace, fixture.snapshot, fixture.insights, fixture.progress);

    const workspacePath = join(root, '.synergy', 'reviews', 'mobile-app-staged', 'workspace.json');
    writeFileSync(
      workspacePath,
      JSON.stringify({ ...fixture.workspace, id: 'another-workspace' }),
      'utf8',
    );

    expect(() => store.readBundle('mobile-app-staged', 'patch-a82c19f')).toThrow(
      'review workspace id does not match requested workspace',
    );
  });

  it('rejects inverted snapshot item ranges during revision creation', () => {
    const root = mkdtempSync(join(tmpdir(), 'synergy-review-'));
    const store = createReviewStore(root);
    const fixture = makeReviewFixture();
    const snapshot = {
      ...fixture.snapshot,
      items: [{ ...fixture.snapshot.items[0], range: { start: 2, end: 1 } }],
    };

    expect(() =>
      store.createRevision(fixture.workspace, snapshot, fixture.insights, fixture.progress),
    ).toThrow('review range start must not exceed end');
  });

  it('rejects unknown persisted question row ids while reading a bundle', () => {
    const root = mkdtempSync(join(tmpdir(), 'synergy-review-'));
    const store = createReviewStore(root);
    const fixture = makeReviewFixture();
    store.createRevision(fixture.workspace, fixture.snapshot, fixture.insights, fixture.progress);

    const queue = createQuestionQueue(root, {
      workspaceId: 'mobile-app-staged',
      revisionId: 'patch-a82c19f',
    });
    const { status: _status, claim: _claim, failureMessage: _failure, ...input } = makeQuestion();
    queue.enqueue(input);
    const questionPath = join(reviewRevisionDirectory(root), 'questions', 'question-abc.json');
    const envelope = JSON.parse(readFileSync(questionPath, 'utf8')) as Record<string, unknown>;
    writeFileSync(
      questionPath,
      JSON.stringify({
        ...envelope,
        selection: { kind: 'scope', selectedLineIds: ['row-injected'] },
      }),
      'utf8',
    );

    expect(() => store.readBundle('mobile-app-staged', 'patch-a82c19f')).toThrow(
      'unknown review row in line selection',
    );
  });

  it('accepts insights with file descriptions for known paths', () => {
    const root = mkdtempSync(join(tmpdir(), 'synergy-review-'));
    const store = createReviewStore(root);
    const fixture = makeReviewFixture();
    const pendingInsights = { ...fixture.insights, groups: [], items: [] };
    store.createRevision(fixture.workspace, fixture.snapshot, pendingInsights, fixture.progress);

    const insights = {
      ...fixture.insights,
      files: [
        { path: 'src/example.ts', description: 'Adds retry logic.', confidence: 'high' as const },
      ],
    };

    expect(() =>
      store.writeInitialInsights(fixture.workspace.id, fixture.snapshot.revisionId, insights),
    ).not.toThrow();
  });

  it('rejects file insights for paths not in the snapshot', () => {
    const root = mkdtempSync(join(tmpdir(), 'synergy-review-'));
    const store = createReviewStore(root);
    const fixture = makeReviewFixture();
    const pendingInsights = { ...fixture.insights, groups: [], items: [] };
    store.createRevision(fixture.workspace, fixture.snapshot, pendingInsights, fixture.progress);

    const insights = {
      ...fixture.insights,
      files: [{ path: 'nope.ts', description: 'x', confidence: 'low' as const }],
    };

    expect(() =>
      store.writeInitialInsights(fixture.workspace.id, fixture.snapshot.revisionId, insights),
    ).toThrow(/file insight references unknown path/);
  });

  it('rejects duplicate file insight paths', () => {
    const root = mkdtempSync(join(tmpdir(), 'synergy-review-'));
    const store = createReviewStore(root);
    const fixture = makeReviewFixture();
    const pendingInsights = { ...fixture.insights, groups: [], items: [] };
    store.createRevision(fixture.workspace, fixture.snapshot, pendingInsights, fixture.progress);

    const f = { path: 'src/example.ts', description: 'x', confidence: 'low' as const };
    const insights = { ...fixture.insights, files: [f, f] };

    expect(() =>
      store.writeInitialInsights(fixture.workspace.id, fixture.snapshot.revisionId, insights),
    ).toThrow(/duplicate file insight path/);
  });

  it('rejects insights that reference review items absent from the snapshot', () => {
    const root = mkdtempSync(join(tmpdir(), 'synergy-review-'));
    const store = createReviewStore(root);
    const fixture = makeReviewFixture();
    const invalidGroupInsights = {
      ...fixture.insights,
      groups: [{ ...fixture.insights.groups[0], reviewItemIds: ['missing-item'] }],
    };
    const invalidItemInsights = {
      ...fixture.insights,
      items: [{ ...fixture.insights.items[0], reviewItemId: 'missing-item' }],
    };

    expect(() =>
      store.createRevision(
        fixture.workspace,
        fixture.snapshot,
        invalidGroupInsights,
        fixture.progress,
      ),
    ).toThrow('review insights reference unknown review item');
    expect(() =>
      store.createRevision(
        fixture.workspace,
        fixture.snapshot,
        invalidItemInsights,
        fixture.progress,
      ),
    ).toThrow('review insights reference unknown review item');

    store.createRevision(fixture.workspace, fixture.snapshot, fixture.insights, fixture.progress);
    writeFileSync(
      join(reviewRevisionDirectory(root), 'insights.json'),
      JSON.stringify(invalidGroupInsights),
      'utf8',
    );

    expect(() => store.readBundle('mobile-app-staged', 'patch-a82c19f')).toThrow(
      'review insights reference unknown review item',
    );

    writeFileSync(
      join(reviewRevisionDirectory(root), 'insights.json'),
      JSON.stringify(invalidItemInsights),
      'utf8',
    );

    expect(() => store.readBundle('mobile-app-staged', 'patch-a82c19f')).toThrow(
      'review insights reference unknown review item',
    );
  });

  it('rejects unknown progress keys and inconsistent review provenance at persistence boundaries', () => {
    const root = mkdtempSync(join(tmpdir(), 'synergy-review-'));
    const store = createReviewStore(root);
    const fixture = makeReviewFixture();

    expect(() =>
      store.createRevision(fixture.workspace, fixture.snapshot, fixture.insights, {
        ...fixture.progress,
        items: {
          ...fixture.progress.items,
          injected: { status: 'reviewed', reviewedAt: fixture.progress.updatedAt },
        },
      }),
    ).toThrow(/unknown review item/i);
    expect(() =>
      store.createRevision(fixture.workspace, fixture.snapshot, fixture.insights, {
        ...fixture.progress,
        items: { 'hunk-abc': { status: 'reviewed' } },
      }),
    ).toThrow(/reviewed.*timestamp/i);
    expect(() =>
      store.createRevision(fixture.workspace, fixture.snapshot, fixture.insights, {
        ...fixture.progress,
        items: {
          'hunk-abc': {
            status: 'carried-forward',
            reviewedAt: fixture.progress.updatedAt,
          },
        },
      }),
    ).toThrow(/carried-forward.*provenance/i);
  });

  it('requires finalized insights and groups to cover every item exactly once', () => {
    const root = mkdtempSync(join(tmpdir(), 'synergy-review-'));
    const fixture = makeReviewFixture();
    const pending = { ...fixture.insights, groups: [], items: [] };
    const store = createReviewStore(root);
    store.createRevision(fixture.workspace, fixture.snapshot, pending, fixture.progress);

    expect(() =>
      store.writeInitialInsights(fixture.workspace.id, fixture.snapshot.revisionId, {
        ...fixture.insights,
        groups: [
          ...fixture.insights.groups,
          { id: 'duplicate-group', label: 'Duplicate', reviewItemIds: ['hunk-abc'] },
        ],
      }),
    ).toThrow(/exactly once/i);
    expect(() =>
      store.writeInitialInsights(fixture.workspace.id, fixture.snapshot.revisionId, {
        ...fixture.insights,
        items: [],
      }),
    ).toThrow(/every review item/i);
    expect(() =>
      store.writeInitialInsights(fixture.workspace.id, fixture.snapshot.revisionId, {
        ...fixture.insights,
        items: [{ ...fixture.insights.items[0]!, evidencePaths: ['outside.ts'] }],
      }),
    ).toThrow(/evidence.*captured files/i);
  });

  it('enforces snapshot-kind item kinds and exact diff file/hunk links', () => {
    const root = mkdtempSync(join(tmpdir(), 'synergy-review-'));
    const fixture = makeReviewFixture();
    const store = createReviewStore(root);
    expect(() =>
      store.createRevision(
        fixture.workspace,
        { ...fixture.snapshot, items: [{ ...fixture.snapshot.items[0]!, kind: 'hunk' }] },
        fixture.insights,
        fixture.progress,
      ),
    ).toThrow(/scoped.*code-section/i);

    const diff = buildDiffSnapshot({
      revisionId: 'diff-revision',
      source: fixture.workspace.source,
      fingerprint: 'diff-fingerprint',
      createdAt: fixture.snapshot.createdAt,
      patch: [
        'diff --git a/src/example.ts b/src/example.ts',
        '--- a/src/example.ts',
        '+++ b/src/example.ts',
        '@@ -1 +1 @@',
        '-old',
        '+new',
        '',
      ].join('\n'),
    });
    const workspace = {
      ...fixture.workspace,
      currentRevisionId: diff.revisionId,
      source: diff.source,
    };
    const item = diff.items[0]!;
    const insights = {
      ...fixture.insights,
      revisionId: diff.revisionId,
      groups: [{ id: 'diff', label: 'Diff', reviewItemIds: [item.id] }],
      items: [{ ...fixture.insights.items[0]!, reviewItemId: item.id }],
    };
    const progress = {
      ...fixture.progress,
      items: { [item.id]: { status: 'needs-review' as const } },
    };
    const broken = {
      ...diff,
      files: diff.files.map((file) => ({
        ...file,
        hunks: file.hunks.map((hunk) => ({ ...hunk, reviewItemId: 'missing-link' })),
      })),
    };
    expect(() => store.createRevision(workspace, broken, insights, progress)).toThrow(
      /diff hunk.*link/i,
    );
  });

  it('rejects questions and answers that do not belong to the requested revision', () => {
    const root = mkdtempSync(join(tmpdir(), 'synergy-review-'));
    const store = createReviewStore(root);
    const fixture = makeReviewFixture();
    store.createRevision(fixture.workspace, fixture.snapshot, fixture.insights, fixture.progress);

    const revisionDir = reviewRevisionDirectory(root);
    const reference = {
      workspaceId: 'mobile-app-staged',
      revisionId: 'patch-a82c19f',
    };
    const queue = createQuestionQueue(root, reference);
    const { status: _status, claim: _claim, failureMessage: _failure, ...input } = makeQuestion();
    queue.enqueue(input);
    const questionPath = join(revisionDir, 'questions', 'question-abc.json');
    const originalEnvelope = readFileSync(questionPath, 'utf8');
    const envelope = JSON.parse(originalEnvelope) as Record<string, unknown>;
    writeFileSync(
      questionPath,
      JSON.stringify({ ...envelope, workspaceId: 'another-workspace' }),
      'utf8',
    );

    expect(() => store.readBundle('mobile-app-staged', 'patch-a82c19f')).toThrow(
      'review question identity does not match requested bundle',
    );

    writeFileSync(
      questionPath,
      JSON.stringify({ ...envelope, reviewItemId: 'missing-item' }),
      'utf8',
    );

    expect(() => store.readBundle('mobile-app-staged', 'patch-a82c19f')).toThrow(
      'review question references an unknown review item',
    );

    writeFileSync(questionPath, originalEnvelope, 'utf8');
    const claim = queue.claim(
      'question-abc',
      'agent-a',
      Date.parse('2026-07-19T10:00:00.000Z'),
      60_000,
    );
    const token = claim.question?.claim?.token;
    if (!token) throw new Error('expected answer fixture claim token');
    const persistedAnswer = queue.answer(
      'question-abc',
      'agent-a',
      token,
      'It demonstrates the staged review fixture.',
      Date.parse('2026-07-19T10:00:01.000Z'),
    );
    expect(store.readBundle('mobile-app-staged', 'patch-a82c19f')).toMatchObject({
      questions: [{ id: 'question-abc', status: 'answered' }],
      answers: [{ id: persistedAnswer.id, questionId: 'question-abc' }],
    });
    const answerPath = join(revisionDir, 'answers', `${persistedAnswer.id}.json`);
    const answer = JSON.parse(readFileSync(answerPath, 'utf8')) as Record<string, unknown>;
    writeFileSync(
      answerPath,
      JSON.stringify({ ...answer, revisionId: 'another-revision' }),
      'utf8',
    );

    expect(() => store.readBundle('mobile-app-staged', 'patch-a82c19f')).toThrow(
      /does not match pending answer bytes/,
    );

    writeFileSync(
      answerPath,
      JSON.stringify({ ...answer, questionId: 'missing-question' }),
      'utf8',
    );

    expect(() => store.readBundle('mobile-app-staged', 'patch-a82c19f')).toThrow(
      /does not match pending answer bytes/,
    );
  });
});
