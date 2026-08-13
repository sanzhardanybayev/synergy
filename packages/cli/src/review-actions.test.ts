import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type RemovalRationale,
  ReviewCoreError,
  type ReviewSnapshot,
  applyCodeSections as applyCoreCodeSections,
  createReviewStore,
  deriveSnapshotRemovalRuns,
  repositoryName,
  reviewRevisionDir,
} from '@synergy/review-core';
import { describe, expect, it } from 'vitest';
import {
  type CreateReviewRequest,
  PreviewNotReadyError,
  applyReviewAnalysis,
  createOrResumeReview,
  formatReviewStatusJson,
  getReviewStatus,
  openReview,
  printReviewStatus,
} from './review-actions.js';
import type { CommandResult, CommandRunner } from './review-capture.js';

const PATCH = [
  'diff --git a/src/example.ts b/src/example.ts',
  'index 1111111..2222222 100644',
  '--- a/src/example.ts',
  '+++ b/src/example.ts',
  '@@ -1 +1 @@',
  '-export const value = 1;',
  '+export const value = 2;',
  '',
].join('\n');

function createRunner(): CommandRunner {
  return {
    run(command, args, options): CommandResult {
      const key = [command, ...args].join(' ');
      if (key === 'git diff --cached --no-ext-diff --binary') {
        return { exitCode: 0, stdout: PATCH, stderr: '' };
      }
      if (key === 'git rev-parse HEAD') return { exitCode: 0, stdout: 'abc123\n', stderr: '' };
      if (key === 'git rev-parse --show-toplevel') {
        return { exitCode: 0, stdout: `${options.cwd}\n`, stderr: '' };
      }
      if (key === 'git config --get remote.origin.url') {
        return { exitCode: 1, stdout: '', stderr: '' };
      }
      throw new Error(`missing fixture for ${key}`);
    },
  };
}

function createRequest(root: string): CreateReviewRequest {
  return { root, source: { kind: 'staged' }, runner: createRunner() };
}

function git(root: string, ...args: string[]): void {
  execFileSync('git', args, { cwd: root });
}

function createRealRepository(root: string): void {
  mkdirSync(root, { recursive: true });
  git(root, 'init', '--quiet');
  git(root, 'config', 'user.email', 'synergy@example.test');
  git(root, 'config', 'user.name', 'Synergy Test');
}

/** Blanket "dead-code" rationale for every derived removal run, sufficient to satisfy the
 * removal-coverage gate in tests that are not themselves exercising removal semantics. */
function removalsForSnapshot(snapshot: ReviewSnapshot): RemovalRationale[] {
  return deriveSnapshotRemovalRuns(snapshot).map((run) => ({
    reviewItemId: run.reviewItemId,
    run: { path: run.path, start: run.start, end: run.end },
    reason: 'dead-code',
    description: 'Removed as part of this change.',
  }));
}

/** A single "moved" rationale for the snapshot's one derived removal run, pointed at a target
 * outside the captured review so `resolveRemovalExcerpts` must read through the injected io. */
function movedOutsideRationale(
  snapshot: ReviewSnapshot,
  reviewItemId: string,
  movedTo: { path: string; start: number; end: number },
): RemovalRationale[] {
  const [run, ...rest] = deriveSnapshotRemovalRuns(snapshot);
  if (!run || rest.length > 0) {
    throw new Error('fixture must derive exactly one removal run');
  }
  return [
    {
      reviewItemId,
      run: { path: run.path, start: run.start, end: run.end },
      reason: 'moved',
      description: 'Moved to another module.',
      movedTo,
    },
  ];
}

/** Wraps a runner to record every command key it receives, in order, for assertions on which
 * git spec a read seam actually used. */
function recordingRunner(base: CommandRunner, calls: string[]): CommandRunner {
  return {
    run(command, args, options): CommandResult {
      calls.push([command, ...args].join(' '));
      return base.run(command, args, options);
    },
  };
}

/** Two files, each with a one-line removal run. `patch` is mutable (a `let` binding the runner
 * reads live) so a test can capture the review, finalize it, then refresh with only file a's
 * content changed - byte-identical file b carries its review item, progress, and removal
 * rationale forward into the refreshed revision. */
function twoFileRemovalPatch(bValue: number): string {
  return [
    'diff --git a/src/a.ts b/src/a.ts',
    'index 1111111..2222222 100644',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1 +1 @@',
    '-export const a = 1;',
    '+export const a = 2;',
    'diff --git a/src/b.ts b/src/b.ts',
    'index 3333333..4444444 100644',
    '--- a/src/b.ts',
    '+++ b/src/b.ts',
    '@@ -1 +1 @@',
    '-export const b = 1;',
    `+export const b = ${bValue};`,
    '',
  ].join('\n');
}

function twoFileRunner(getPatch: () => string): CommandRunner {
  return {
    run(command, args, options): CommandResult {
      const key = [command, ...args].join(' ');
      if (key === 'git diff --cached --no-ext-diff --binary') {
        return { exitCode: 0, stdout: getPatch(), stderr: '' };
      }
      if (key === 'git rev-parse HEAD') return { exitCode: 0, stdout: 'abc123\n', stderr: '' };
      if (key === 'git rev-parse --show-toplevel') {
        return { exitCode: 0, stdout: `${options.cwd}\n`, stderr: '' };
      }
      if (key === 'git config --get remote.origin.url') {
        return { exitCode: 1, stdout: '', stderr: '' };
      }
      throw new Error(`missing fixture for ${key}`);
    },
  };
}

/** Captures, finalizes (with a removal rationale per file), and reviews item b so it carries
 * forward on refresh; then refreshes with only file a's content changed. Returns everything a
 * carry-forward test needs: the refreshed (unfinalized) revision's reference, its bundle, and
 * both review items. */
async function setupRefreshedReviewWithCarriedRemoval(root: string): Promise<{
  refreshed: { reference: { workspaceId: string; revisionId: string } };
  store: ReturnType<typeof createReviewStore>;
  refreshedBundle: ReturnType<ReturnType<typeof createReviewStore>['readBundle']>;
  refreshedItemA: { id: string; path: string };
  refreshedItemB: { id: string; path: string };
}> {
  let patch = twoFileRemovalPatch(2);
  const runner = twoFileRunner(() => patch);
  const first = createOrResumeReview({ root, source: { kind: 'staged' }, runner });
  const store = createReviewStore(root);
  const firstSnapshot = store.readBundle(
    first.reference.workspaceId,
    first.reference.revisionId,
  ).snapshot;
  const itemA = firstSnapshot.items.find((item) => item.path === 'src/a.ts');
  const itemB = firstSnapshot.items.find((item) => item.path === 'src/b.ts');
  if (!itemA || !itemB) throw new Error('fixture capture must create two review items');

  await applyReviewAnalysis({
    root,
    reference: first.reference,
    analysis: {
      kind: 'diff',
      groups: [{ id: 'core', label: 'Core', reviewItemIds: [itemA.id, itemB.id] }],
      items: [
        {
          reviewItemId: itemA.id,
          description: 'Updates constant a.',
          confidence: 'high',
          evidencePaths: ['src/a.ts'],
        },
        {
          reviewItemId: itemB.id,
          description: 'Updates constant b.',
          confidence: 'high',
          evidencePaths: ['src/b.ts'],
        },
      ],
      removals: removalsForSnapshot(firstSnapshot),
    },
  });
  store.patchItemProgress(first.reference.workspaceId, first.reference.revisionId, itemB.id, {
    status: 'reviewed',
  });

  // Refresh: only file a's content changes; file b's hunk is byte-identical, so its review item
  // (and the removal rationale for it) carries forward into the new revision.
  patch = twoFileRemovalPatch(2).replace('export const a = 2;', 'export const a = 3;');
  const refreshed = createOrResumeReview({ root, source: { kind: 'staged' }, runner });
  const refreshedBundle = store.readBundle(
    refreshed.reference.workspaceId,
    refreshed.reference.revisionId,
  );
  const refreshedItemA = refreshedBundle.snapshot.items.find((item) => item.path === 'src/a.ts');
  const refreshedItemB = refreshedBundle.snapshot.items.find((item) => item.path === 'src/b.ts');
  if (!refreshedItemA || !refreshedItemB) {
    throw new Error('refreshed snapshot must retain both review items');
  }
  return { refreshed, store, refreshedBundle, refreshedItemA, refreshedItemB };
}

/** A staged runner over the two-file removal patch that also answers `git show :src/other.ts`
 * from a mutable getter, so a test can change what the "moved to" destination contains (or make
 * it unreadable) between the initial capture/finalize and a later refresh. */
function stagedMovedRunner(
  getPatch: () => string,
  getOtherContent: () => string | undefined,
): CommandRunner {
  return {
    run(command, args, options): CommandResult {
      const key = [command, ...args].join(' ');
      if (key === 'git diff --cached --no-ext-diff --binary') {
        return { exitCode: 0, stdout: getPatch(), stderr: '' };
      }
      if (key === 'git show :src/other.ts') {
        const content = getOtherContent();
        return content === undefined
          ? { exitCode: 1, stdout: '', stderr: 'fatal: path does not exist' }
          : { exitCode: 0, stdout: content, stderr: '' };
      }
      if (key === 'git rev-parse HEAD') return { exitCode: 0, stdout: 'abc123\n', stderr: '' };
      if (key === 'git rev-parse --show-toplevel') {
        return { exitCode: 0, stdout: `${options.cwd}\n`, stderr: '' };
      }
      if (key === 'git config --get remote.origin.url') {
        return { exitCode: 1, stdout: '', stderr: '' };
      }
      throw new Error(`missing fixture for ${key}`);
    },
  };
}

/** Sets up revision 1 (files a and b) with item a explained by a plain rationale and item b
 * explained by a "moved" rationale pointing outside the captured review at `src/other.ts:5-6`,
 * marks item b reviewed so it carries forward, and finalizes. Returns the runner (so the caller
 * can mutate `patch`/`otherContent` and trigger a refresh) plus the store and both item ids. */
async function setupCarriedMovedRationale(
  root: string,
  otherContent: { value: string | undefined },
): Promise<{
  store: ReturnType<typeof createReviewStore>;
  runner: CommandRunner;
  patch: { value: string };
  firstReference: { workspaceId: string; revisionId: string };
  itemAId: string;
  itemBId: string;
}> {
  const patch = { value: twoFileRemovalPatch(2) };
  const runner = stagedMovedRunner(
    () => patch.value,
    () => otherContent.value,
  );
  const first = createOrResumeReview({ root, source: { kind: 'staged' }, runner });
  const store = createReviewStore(root);
  const firstSnapshot = store.readBundle(
    first.reference.workspaceId,
    first.reference.revisionId,
  ).snapshot;
  const itemA = firstSnapshot.items.find((item) => item.path === 'src/a.ts');
  const itemB = firstSnapshot.items.find((item) => item.path === 'src/b.ts');
  if (!itemA || !itemB) throw new Error('fixture capture must create two review items');
  const [runA] = deriveSnapshotRemovalRuns(firstSnapshot).filter(
    (run) => run.reviewItemId === itemA.id,
  );
  const [runB] = deriveSnapshotRemovalRuns(firstSnapshot).filter(
    (run) => run.reviewItemId === itemB.id,
  );
  if (!runA || !runB) throw new Error('fixture must derive removal runs for both items');

  await applyReviewAnalysis({
    root,
    reference: first.reference,
    analysis: {
      kind: 'diff',
      groups: [{ id: 'core', label: 'Core', reviewItemIds: [itemA.id, itemB.id] }],
      items: [
        {
          reviewItemId: itemA.id,
          description: 'Updates constant a.',
          confidence: 'high',
          evidencePaths: ['src/a.ts'],
        },
        {
          reviewItemId: itemB.id,
          description: 'Updates constant b.',
          confidence: 'high',
          evidencePaths: ['src/b.ts'],
        },
      ],
      removals: [
        {
          reviewItemId: itemA.id,
          run: { path: runA.path, start: runA.start, end: runA.end },
          reason: 'dead-code',
          description: 'Removed as part of this change.',
        },
        {
          reviewItemId: itemB.id,
          run: { path: runB.path, start: runB.start, end: runB.end },
          reason: 'moved',
          description: 'Moved to another module.',
          movedTo: { path: 'src/other.ts', start: 5, end: 6 },
        },
      ],
    },
    runner,
  });
  store.patchItemProgress(first.reference.workspaceId, first.reference.revisionId, itemB.id, {
    status: 'reviewed',
  });

  return {
    store,
    runner,
    patch,
    firstReference: first.reference,
    itemAId: itemA.id,
    itemBId: itemB.id,
  };
}

describe('review lifecycle actions', () => {
  it('uses canonical shared freshness for text and JSON readiness, failing capture closed', async () => {
    const root = join(tmpdir(), `synergy-review-status-${Date.now()}`);
    const nested = join(root, 'src');
    mkdirSync(nested, { recursive: true });
    const baseRunner = createRunner();
    const runner: CommandRunner = {
      run(command, args, options): CommandResult {
        if ([command, ...args].join(' ') === 'git rev-parse --show-toplevel') {
          return { exitCode: 0, stdout: `${root}\n`, stderr: '' };
        }
        return baseRunner.run(command, args, options);
      },
    };
    try {
      const created = createOrResumeReview(createRequest(root));
      const store = createReviewStore(root);
      const snapshot = store.readBundle(
        created.reference.workspaceId,
        created.reference.revisionId,
      ).snapshot;
      const item = snapshot.items[0]!;
      await applyReviewAnalysis({
        root,
        reference: created.reference,
        analysis: {
          kind: 'diff',
          groups: [{ id: 'core', label: 'Core', reviewItemIds: [item.id] }],
          items: [
            {
              reviewItemId: item.id,
              description: 'Updates the staged fixture value.',
              confidence: 'high',
              evidencePaths: [item.path],
            },
          ],
          removals: removalsForSnapshot(snapshot),
        },
      });
      store.patchItemProgress(
        created.reference.workspaceId,
        created.reference.revisionId,
        item.id,
        {
          status: 'reviewed',
        },
      );
      let comparedRoot = '';
      const unchanged = printReviewStatus({
        root: nested,
        reference: created.reference,
        runner,
        compareSourceFreshness: (_snapshot, canonicalRoot) => {
          comparedRoot = canonicalRoot;
          return { sourceChanged: false, captureFailed: false };
        },
      });
      const changedJson = JSON.parse(
        formatReviewStatusJson({
          root: nested,
          reference: created.reference,
          runner,
          compareSourceFreshness: () => ({ sourceChanged: true, captureFailed: false }),
        }),
      ) as { readiness: { ready: boolean; sourceChanged: boolean }; captureFailed: boolean };
      const failedJson = JSON.parse(
        formatReviewStatusJson({
          root: nested,
          reference: created.reference,
          runner,
          compareSourceFreshness: () => ({ sourceChanged: true, captureFailed: true }),
        }),
      ) as { readiness: { ready: boolean; sourceChanged: boolean }; captureFailed: boolean };

      expect(comparedRoot).toBe(realpathSync(root));
      expect(unchanged).toContain('\nready\n');
      expect(changedJson).toMatchObject({
        readiness: { ready: false, sourceChanged: true },
        captureFailed: false,
      });
      expect(failedJson).toMatchObject({
        readiness: { ready: false, sourceChanged: true },
        captureFailed: true,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('resumes the exact immutable revision for an identical capture', () => {
    const root = join(tmpdir(), `synergy-review-actions-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    try {
      const first = createOrResumeReview(createRequest(root));
      const second = createOrResumeReview(createRequest(root));

      expect(second.reference).toEqual(first.reference);
      expect(second.resumed).toBe(true);
      expect(second.analysisRequired).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps diff create and status results free of scoped analysis guidance', () => {
    const root = join(tmpdir(), `synergy-review-diff-guidance-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    try {
      const created = createOrResumeReview(createRequest(root));
      const status = JSON.parse(
        formatReviewStatusJson({ root, reference: created.reference, runner: createRunner() }),
      ) as Record<string, unknown>;

      expect(created).not.toHaveProperty('analysisGuidance');
      expect(status).not.toHaveProperty('analysisGuidance');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports every derived removal run and its coverage in create and status', () => {
    const root = join(tmpdir(), `synergy-review-removals-status-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    try {
      const created = createOrResumeReview(createRequest(root));
      const snapshot = createReviewStore(root).readBundle(
        created.reference.workspaceId,
        created.reference.revisionId,
      ).snapshot;
      const [run, ...rest] = deriveSnapshotRemovalRuns(snapshot);
      if (!run || rest.length > 0) throw new Error('fixture must derive exactly one removal run');
      const expected = [
        {
          reviewItemId: run.reviewItemId,
          path: run.path,
          start: run.start,
          end: run.end,
          covered: false,
        },
      ];

      expect(created.removals).toEqual(expected);
      expect(
        getReviewStatus({ root, reference: created.reference, runner: createRunner() }).removals,
      ).toEqual(expected);
      expect(
        printReviewStatus({ root, reference: created.reference, runner: createRunner() }),
      ).toContain('removals: 0/1 explained');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('marks removal runs covered once analysis is finalized', async () => {
    const root = join(tmpdir(), `synergy-review-removals-covered-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    try {
      const created = createOrResumeReview(createRequest(root));
      const snapshot = createReviewStore(root).readBundle(
        created.reference.workspaceId,
        created.reference.revisionId,
      ).snapshot;
      const reviewItemId = snapshot.items[0]?.id;
      if (!reviewItemId) throw new Error('fixture capture must create one review item');
      await applyReviewAnalysis({
        root,
        reference: created.reference,
        analysis: {
          kind: 'diff',
          groups: [{ id: 'core', label: 'Core', reviewItemIds: [reviewItemId] }],
          items: [
            {
              reviewItemId,
              description: 'Updates the staged fixture value.',
              confidence: 'high',
              evidencePaths: [snapshot.items[0]!.path],
            },
          ],
          removals: removalsForSnapshot(snapshot),
        },
      });

      const status = getReviewStatus({
        root,
        reference: created.reference,
        runner: createRunner(),
      });
      expect(status.removals[0]?.covered).toBe(true);
      expect(
        printReviewStatus({ root, reference: created.reference, runner: createRunner() }),
      ).toContain('removals: 1/1 explained');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('accepts a finalize payload that omits a carried removal rationale, keeping it covered and persisted', async () => {
    const root = join(tmpdir(), `synergy-review-removal-carry-omit-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    try {
      const { refreshed, store, refreshedBundle, refreshedItemA, refreshedItemB } =
        await setupRefreshedReviewWithCarriedRemoval(root);

      // Before finalizing: status must already report item b's run as covered (carried) and
      // item a's as not - this is the prediction that finalize-time acceptance must honor.
      const preFinalizeRunner = twoFileRunner(() =>
        twoFileRemovalPatch(2).replace('export const a = 2;', 'export const a = 3;'),
      );
      const preStatus = getReviewStatus({
        root,
        reference: refreshed.reference,
        runner: preFinalizeRunner,
      });
      const removalForA = preStatus.removals.find((r) => r.reviewItemId === refreshedItemA.id);
      const removalForB = preStatus.removals.find((r) => r.reviewItemId === refreshedItemB.id);
      expect(removalForA?.covered).toBe(false);
      expect(removalForB?.covered).toBe(true);

      const [runB] = deriveSnapshotRemovalRuns(refreshedBundle.snapshot).filter(
        (run) => run.reviewItemId === refreshedItemB.id,
      );
      if (!runB) throw new Error('fixture must derive a removal run for item b');
      const carriedRationale = refreshedBundle.insights.removals?.find(
        (rationale) => rationale.reviewItemId === refreshedItemB.id,
      );
      expect(carriedRationale).toEqual({
        reviewItemId: refreshedItemB.id,
        run: { path: runB.path, start: runB.start, end: runB.end },
        reason: 'dead-code',
        description: 'Removed as part of this change.',
      });

      // Finalize with a payload that only explains item a's removal run - item b's carried
      // rationale is omitted, exactly as an agent trusting `covered: true` would do.
      const [runA] = deriveSnapshotRemovalRuns(refreshedBundle.snapshot).filter(
        (run) => run.reviewItemId === refreshedItemA.id,
      );
      if (!runA) throw new Error('fixture must derive a removal run for item a');
      await applyReviewAnalysis({
        root,
        reference: refreshed.reference,
        analysis: {
          kind: 'diff',
          groups: [
            { id: 'core', label: 'Core', reviewItemIds: [refreshedItemA.id, refreshedItemB.id] },
          ],
          items: [
            {
              reviewItemId: refreshedItemA.id,
              description: 'Updates constant a again.',
              confidence: 'high',
              evidencePaths: ['src/a.ts'],
            },
            {
              reviewItemId: refreshedItemB.id,
              description: 'Updates constant b.',
              confidence: 'high',
              evidencePaths: ['src/b.ts'],
            },
          ],
          removals: [
            {
              reviewItemId: refreshedItemA.id,
              run: { path: runA.path, start: runA.start, end: runA.end },
              reason: 'dead-code',
              description: 'Removed as part of the refreshed change.',
            },
          ],
        },
      });

      const finalized = store.readBundle(
        refreshed.reference.workspaceId,
        refreshed.reference.revisionId,
      );
      expect(finalized.insights.removals).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            reviewItemId: refreshedItemA.id,
            description: 'Removed as part of the refreshed change.',
          }),
          carriedRationale,
        ]),
      );
      expect(finalized.insights.removals).toHaveLength(2);

      const postStatus = getReviewStatus({
        root,
        reference: refreshed.reference,
        runner: preFinalizeRunner,
      });
      expect(postStatus.removals.every((r) => r.covered)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('overrides a carried removal rationale when the finalize payload includes a fresh one for the same run', async () => {
    const root = join(tmpdir(), `synergy-review-removal-carry-override-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    try {
      const { refreshed, store, refreshedBundle, refreshedItemA, refreshedItemB } =
        await setupRefreshedReviewWithCarriedRemoval(root);
      const [runA] = deriveSnapshotRemovalRuns(refreshedBundle.snapshot).filter(
        (run) => run.reviewItemId === refreshedItemA.id,
      );
      const [runB] = deriveSnapshotRemovalRuns(refreshedBundle.snapshot).filter(
        (run) => run.reviewItemId === refreshedItemB.id,
      );
      if (!runA || !runB) throw new Error('fixture must derive removal runs for both items');

      await applyReviewAnalysis({
        root,
        reference: refreshed.reference,
        analysis: {
          kind: 'diff',
          groups: [
            { id: 'core', label: 'Core', reviewItemIds: [refreshedItemA.id, refreshedItemB.id] },
          ],
          items: [
            {
              reviewItemId: refreshedItemA.id,
              description: 'Updates constant a again.',
              confidence: 'high',
              evidencePaths: ['src/a.ts'],
            },
            {
              reviewItemId: refreshedItemB.id,
              description: 'Updates constant b.',
              confidence: 'high',
              evidencePaths: ['src/b.ts'],
            },
          ],
          removals: [
            {
              reviewItemId: refreshedItemA.id,
              run: { path: runA.path, start: runA.start, end: runA.end },
              reason: 'dead-code',
              description: 'Removed as part of the refreshed change.',
            },
            {
              reviewItemId: refreshedItemB.id,
              run: { path: runB.path, start: runB.start, end: runB.end },
              reason: 'obsolete',
              description: 'Superseded rationale authored on the refreshed revision.',
            },
          ],
        },
      });

      const finalized = store.readBundle(
        refreshed.reference.workspaceId,
        refreshed.reference.revisionId,
      );
      const persistedForB = finalized.insights.removals?.find(
        (rationale) => rationale.reviewItemId === refreshedItemB.id,
      );
      expect(persistedForB).toEqual({
        reviewItemId: refreshedItemB.id,
        run: { path: runB.path, start: runB.start, end: runB.end },
        reason: 'obsolete',
        description: 'Superseded rationale authored on the refreshed revision.',
      });
      expect(finalized.insights.removals).toHaveLength(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('re-resolves a carried moved-to excerpt against the new revision, replacing stale text', async () => {
    const root = join(tmpdir(), `synergy-review-removal-excerpt-refresh-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    try {
      const otherContent: { value: string | undefined } = { value: 'l1\nl2\nl3\nl4\nl5\nl6\n' };
      const { store, runner, patch, firstReference, itemBId } = await setupCarriedMovedRationale(
        root,
        otherContent,
      );
      const firstBundle = store.readBundle(firstReference.workspaceId, firstReference.revisionId);
      const originalExcerpt = firstBundle.insights.removals?.find(
        (rationale) => rationale.reviewItemId === itemBId,
      )?.movedToExcerpt;
      expect(originalExcerpt).toEqual({ path: 'src/other.ts', start: 5, lines: ['l5', 'l6'] });

      // Refresh: file a changes (so a new revision is created); the destination file's content
      // also changed since the first revision was captured.
      patch.value = twoFileRemovalPatch(2).replace('export const a = 2;', 'export const a = 3;');
      otherContent.value = 'm1\nm2\nm3\nm4\nm5\nm6\n';
      const refreshed = createOrResumeReview({ root, source: { kind: 'staged' }, runner });
      const refreshedBundle = store.readBundle(
        refreshed.reference.workspaceId,
        refreshed.reference.revisionId,
      );
      const refreshedItemB = refreshedBundle.snapshot.items.find(
        (item) => item.path === 'src/b.ts',
      );
      if (!refreshedItemB) throw new Error('refreshed snapshot must retain item b');
      const carried = refreshedBundle.insights.removals?.find(
        (rationale) => rationale.reviewItemId === refreshedItemB.id,
      );
      expect(carried?.movedToExcerpt).toEqual({
        path: 'src/other.ts',
        start: 5,
        lines: ['m5', 'm6'],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('drops a carried removal rationale whose moved-to destination can no longer be read', async () => {
    const root = join(tmpdir(), `synergy-review-removal-excerpt-missing-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    try {
      const otherContent: { value: string | undefined } = { value: 'l1\nl2\nl3\nl4\nl5\nl6\n' };
      const { store, runner, patch } = await setupCarriedMovedRationale(root, otherContent);

      // Refresh: file a changes, and the destination file has disappeared.
      patch.value = twoFileRemovalPatch(2).replace('export const a = 2;', 'export const a = 3;');
      otherContent.value = undefined;
      const refreshed = createOrResumeReview({ root, source: { kind: 'staged' }, runner });
      const refreshedBundle = store.readBundle(
        refreshed.reference.workspaceId,
        refreshed.reference.revisionId,
      );
      const refreshedItemB = refreshedBundle.snapshot.items.find(
        (item) => item.path === 'src/b.ts',
      );
      if (!refreshedItemB) throw new Error('refreshed snapshot must retain item b');
      expect(
        (refreshedBundle.insights.removals ?? []).some(
          (rationale) => rationale.reviewItemId === refreshedItemB.id,
        ),
      ).toBe(false);

      const status = getReviewStatus({ root, reference: refreshed.reference, runner });
      const removalForB = status.removals.find((r) => r.reviewItemId === refreshedItemB.id);
      expect(removalForB?.covered).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('drops a carried removal rationale whose moved-to range now overruns the destination file', async () => {
    const root = join(tmpdir(), `synergy-review-removal-excerpt-overrun-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    try {
      const otherContent: { value: string | undefined } = { value: 'l1\nl2\nl3\nl4\nl5\nl6\n' };
      const { store, runner, patch } = await setupCarriedMovedRationale(root, otherContent);

      // Refresh: file a changes, and the destination file shrank below the rationale's range
      // (start 5, end 6).
      patch.value = twoFileRemovalPatch(2).replace('export const a = 2;', 'export const a = 3;');
      otherContent.value = 'm1\nm2\nm3\n';
      const refreshed = createOrResumeReview({ root, source: { kind: 'staged' }, runner });
      const refreshedBundle = store.readBundle(
        refreshed.reference.workspaceId,
        refreshed.reference.revisionId,
      );
      const refreshedItemB = refreshedBundle.snapshot.items.find(
        (item) => item.path === 'src/b.ts',
      );
      if (!refreshedItemB) throw new Error('refreshed snapshot must retain item b');
      expect(
        (refreshedBundle.insights.removals ?? []).some(
          (rationale) => rationale.reviewItemId === refreshedItemB.id,
        ),
      ).toBe(false);

      const status = getReviewStatus({ root, reference: refreshed.reference, runner });
      const removalForB = status.removals.find((r) => r.reviewItemId === refreshedItemB.id);
      expect(removalForB?.covered).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('sheds a carried moved-to excerpt once the destination lands inside the new capture', async () => {
    const root = join(tmpdir(), `synergy-review-removal-excerpt-inreview-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    try {
      const otherContent: { value: string | undefined } = { value: 'l1\nl2\nl3\nl4\nl5\nl6\n' };
      const { store, runner, patch } = await setupCarriedMovedRationale(root, otherContent);

      // Refresh: file a changes, and the destination file (src/other.ts) is now itself part of
      // the captured diff, with ADDED new-side lines 5 and 6 falling inside its hunk - the same
      // span the carried rationale's movedTo already names. (Context rows sharing those new-side
      // line numbers would not count: an in-review jump must land on lines that were actually
      // added, not merely present.)
      const otherHunk = [
        'diff --git a/src/other.ts b/src/other.ts',
        'index 7777777..8888888 100644',
        '--- a/src/other.ts',
        '+++ b/src/other.ts',
        '@@ -1,6 +1,6 @@',
        '-old1',
        '+new1',
        ' ctx2',
        ' ctx3',
        ' ctx4',
        '-old5',
        '+new5',
        '-old6',
        '+new6',
      ].join('\n');
      patch.value = `${twoFileRemovalPatch(2).replace('export const a = 2;', 'export const a = 3;').trimEnd()}\n${otherHunk}\n`;
      const refreshed = createOrResumeReview({ root, source: { kind: 'staged' }, runner });
      const refreshedBundle = store.readBundle(
        refreshed.reference.workspaceId,
        refreshed.reference.revisionId,
      );
      const refreshedItemB = refreshedBundle.snapshot.items.find(
        (item) => item.path === 'src/b.ts',
      );
      if (!refreshedItemB) throw new Error('refreshed snapshot must retain item b');
      const carried = refreshedBundle.insights.removals?.find(
        (rationale) => rationale.reviewItemId === refreshedItemB.id,
      );
      expect(carried).toEqual({
        reviewItemId: refreshedItemB.id,
        run: expect.objectContaining({ path: 'src/b.ts' }),
        reason: 'moved',
        description: 'Moved to another module.',
        movedTo: { path: 'src/other.ts', start: 5, end: 6 },
      });
      expect(carried).not.toHaveProperty('movedToExcerpt');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('drops a carried removal rationale whose moved-to path fails the safety guard on refresh, without aborting the refresh', async () => {
    const root = join(tmpdir(), `synergy-review-removal-excerpt-unsafe-path-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    try {
      const otherContent: { value: string | undefined } = { value: 'l1\nl2\nl3\nl4\nl5\nl6\n' };
      const { store, runner, patch, firstReference, itemBId } = await setupCarriedMovedRationale(
        root,
        otherContent,
      );

      // Simulate a rationale persisted by a pre-fix build: hand-edit the already-finalized
      // revision's bundle on disk so item b's carried `movedTo.path` is a path-traversal escape.
      // `applyReviewAnalysis` itself would reject this at creation time (the same
      // `assertSafeEvidencePath` guard runs there too), so this bypasses that seam on purpose to
      // exercise the defence-in-depth re-check inside `reResolveCarriedRemovals` on refresh.
      const bundlePath = join(
        reviewRevisionDir(root, firstReference.workspaceId, firstReference.revisionId),
        'bundle.json',
      );
      const bundle = JSON.parse(readFileSync(bundlePath, 'utf8')) as {
        insights: { removals?: RemovalRationale[] };
      };
      const rationale = bundle.insights.removals?.find((r) => r.reviewItemId === itemBId);
      if (!rationale?.movedTo) {
        throw new Error('fixture must persist a moved-to rationale for item b');
      }
      rationale.movedTo = { ...rationale.movedTo, path: '../../.ssh/id_rsa' };
      writeFileSync(bundlePath, JSON.stringify(bundle));

      // Refresh: file a changes; file b's byte-identical hunk carries forward, dragging the
      // now-unsafe rationale along with it.
      patch.value = twoFileRemovalPatch(2).replace('export const a = 2;', 'export const a = 3;');
      const refreshed = createOrResumeReview({ root, source: { kind: 'staged' }, runner });
      const refreshedBundle = store.readBundle(
        refreshed.reference.workspaceId,
        refreshed.reference.revisionId,
      );
      const refreshedItemB = refreshedBundle.snapshot.items.find(
        (item) => item.path === 'src/b.ts',
      );
      if (!refreshedItemB) throw new Error('refreshed snapshot must retain item b');

      // 1. Dropped: the unsafe rationale does not appear in the new revision's insights.removals.
      expect(
        (refreshedBundle.insights.removals ?? []).some(
          (rationale) => rationale.reviewItemId === refreshedItemB.id,
        ),
      ).toBe(false);

      // 2. The refresh itself succeeded rather than throwing, and its run reports uncovered.
      const status = getReviewStatus({ root, reference: refreshed.reference, runner });
      const removalForB = status.removals.find((r) => r.reviewItemId === refreshedItemB.id);
      expect(removalForB?.covered).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('drops a carried removal rationale when its target read throws instead of resolving, without aborting the refresh', async () => {
    const root = join(tmpdir(), `synergy-review-removal-excerpt-throws-create-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    const unstagedDiffCommand = [
      'git',
      'diff',
      '--no-ext-diff',
      '--binary',
      '--',
      ':(exclude).synergy/preview.runtime.json',
      ':(exclude).synergy/preview.runtime.json.*',
      ':(exclude).synergy/.preview.runtime.json.*.tmp',
      ':(exclude).synergy/preview.start.lock',
      ':(exclude).synergy/preview.start.lock.*',
      ':(exclude).synergy/preview.pid',
      ':(exclude).synergy/preview.log',
    ].join(' ');
    try {
      let patch = twoFileRemovalPatch(2);
      const runner: CommandRunner = {
        run(command, args, options): CommandResult {
          const key = [command, ...args].join(' ');
          if (key === 'git rev-parse --show-toplevel') {
            return { exitCode: 0, stdout: `${options.cwd}\n`, stderr: '' };
          }
          if (key === 'git rev-parse HEAD') return { exitCode: 0, stdout: 'abc123\n', stderr: '' };
          if (key === unstagedDiffCommand) return { exitCode: 0, stdout: patch, stderr: '' };
          if (key === 'git ls-files --others --exclude-standard -z') {
            return { exitCode: 0, stdout: '', stderr: '' };
          }
          throw new Error(`missing fixture for ${key}`);
        },
      };
      const first = createOrResumeReview({
        root,
        source: { kind: 'unstaged' },
        runner,
        readFile: () => 'unused',
      });
      const store = createReviewStore(root);
      const firstSnapshot = store.readBundle(
        first.reference.workspaceId,
        first.reference.revisionId,
      ).snapshot;
      const itemA = firstSnapshot.items.find((item) => item.path === 'src/a.ts');
      const itemB = firstSnapshot.items.find((item) => item.path === 'src/b.ts');
      if (!itemA || !itemB) throw new Error('fixture capture must create two review items');
      const [runA] = deriveSnapshotRemovalRuns(firstSnapshot).filter(
        (run) => run.reviewItemId === itemA.id,
      );
      const [runB] = deriveSnapshotRemovalRuns(firstSnapshot).filter(
        (run) => run.reviewItemId === itemB.id,
      );
      if (!runA || !runB) throw new Error('fixture must derive removal runs for both items');
      const targetPath = join(root, 'src/other.ts');

      await applyReviewAnalysis({
        root,
        reference: first.reference,
        analysis: {
          kind: 'diff',
          groups: [{ id: 'core', label: 'Core', reviewItemIds: [itemA.id, itemB.id] }],
          items: [
            {
              reviewItemId: itemA.id,
              description: 'Updates constant a.',
              confidence: 'high',
              evidencePaths: ['src/a.ts'],
            },
            {
              reviewItemId: itemB.id,
              description: 'Updates constant b.',
              confidence: 'high',
              evidencePaths: ['src/b.ts'],
            },
          ],
          removals: [
            {
              reviewItemId: itemA.id,
              run: { path: runA.path, start: runA.start, end: runA.end },
              reason: 'dead-code',
              description: 'Removed as part of this change.',
            },
            {
              reviewItemId: itemB.id,
              run: { path: runB.path, start: runB.start, end: runB.end },
              reason: 'moved',
              description: 'Moved to another module.',
              movedTo: { path: 'src/other.ts', start: 5, end: 6 },
            },
          ],
        },
        runner,
        readFile: (path) => (path === targetPath ? 'l1\nl2\nl3\nl4\nl5\nl6\n' : undefined),
      });
      store.patchItemProgress(first.reference.workspaceId, first.reference.revisionId, itemB.id, {
        status: 'reviewed',
      });

      // Refresh: file a changes; the destination read now throws a non-ENOENT error (EACCES),
      // exercising the unstaged/scope `readFile` seam directly rather than the staged `git show`
      // path exercised by the other carry-forward excerpt tests.
      patch = twoFileRemovalPatch(2).replace('export const a = 2;', 'export const a = 3;');
      const refreshed = createOrResumeReview(
        { root, source: { kind: 'unstaged' }, runner, readFile: () => 'unused' },
        {
          readFile: (path) => {
            if (path === targetPath) {
              throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
            }
            return undefined;
          },
        },
      );
      const refreshedBundle = store.readBundle(
        refreshed.reference.workspaceId,
        refreshed.reference.revisionId,
      );
      const refreshedItemB = refreshedBundle.snapshot.items.find(
        (item) => item.path === 'src/b.ts',
      );
      if (!refreshedItemB) throw new Error('refreshed snapshot must retain item b');
      expect(
        (refreshedBundle.insights.removals ?? []).some(
          (rationale) => rationale.reviewItemId === refreshedItemB.id,
        ),
      ).toBe(false);

      const status = getReviewStatus({ root, reference: refreshed.reference, runner });
      const removalForB = status.removals.find((r) => r.reviewItemId === refreshedItemB.id);
      expect(removalForB?.covered).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('still rejects a live analysis submission when a moved-to target read throws, not just when it is missing', async () => {
    const root = join(tmpdir(), `synergy-review-removals-excerpt-throws-finalize-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    const unstagedDiffCommand = [
      'git',
      'diff',
      '--no-ext-diff',
      '--binary',
      '--',
      ':(exclude).synergy/preview.runtime.json',
      ':(exclude).synergy/preview.runtime.json.*',
      ':(exclude).synergy/.preview.runtime.json.*.tmp',
      ':(exclude).synergy/preview.start.lock',
      ':(exclude).synergy/preview.start.lock.*',
      ':(exclude).synergy/preview.pid',
      ':(exclude).synergy/preview.log',
    ].join(' ');
    try {
      const fixture: CommandRunner = {
        run(command, args, options): CommandResult {
          const key = [command, ...args].join(' ');
          if (key === 'git rev-parse --show-toplevel') {
            return { exitCode: 0, stdout: `${options.cwd}\n`, stderr: '' };
          }
          if (key === 'git rev-parse HEAD') return { exitCode: 0, stdout: 'abc123\n', stderr: '' };
          if (key === unstagedDiffCommand) return { exitCode: 0, stdout: PATCH, stderr: '' };
          if (key === 'git ls-files --others --exclude-standard -z') {
            return { exitCode: 0, stdout: '', stderr: '' };
          }
          throw new Error(`missing fixture for ${key}`);
        },
      };
      const created = createOrResumeReview({
        root,
        source: { kind: 'unstaged' },
        runner: fixture,
        readFile: () => 'unused',
      });
      const store = createReviewStore(root);
      const snapshot = store.readBundle(
        created.reference.workspaceId,
        created.reference.revisionId,
      ).snapshot;
      const item = snapshot.items[0]!;
      const removals = movedOutsideRationale(snapshot, item.id, {
        path: 'src/other.ts',
        start: 5,
        end: 6,
      });
      const targetPath = join(root, 'src/other.ts');

      await expect(
        applyReviewAnalysis({
          root,
          reference: created.reference,
          analysis: {
            kind: 'diff',
            groups: [{ id: 'core', label: 'Core', reviewItemIds: [item.id] }],
            items: [
              {
                reviewItemId: item.id,
                description: 'Updates the unstaged fixture value.',
                confidence: 'high',
                evidencePaths: [item.path],
              },
            ],
            removals,
          },
          runner: fixture,
          readFile: (path) => {
            if (path === targetPath) {
              throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
            }
            return undefined;
          },
        }),
      ).rejects.toThrow(/permission denied/);
      expect(
        store.isAnalysisFinalized(created.reference.workspaceId, created.reference.revisionId),
      ).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('resumes an initial revision orphaned before workspace pointer publication', () => {
    const root = join(tmpdir(), `Synergy Review Orphan ${Date.now()}`);
    mkdirSync(root, { recursive: true });
    let failOnce = true;
    try {
      expect(() =>
        createOrResumeReview(createRequest(root), {
          createStore: (canonicalRoot) =>
            createReviewStore(canonicalRoot, {
              beforeWorkspacePublish: () => {
                if (!failOnce) return;
                failOnce = false;
                throw new Error('crash before workspace pointer');
              },
            }),
        }),
      ).toThrow(/crash before workspace pointer/i);

      const resumed = createOrResumeReview(createRequest(root));
      expect(resumed.resumed).toBe(true);
      const store = createReviewStore(root);
      const workspace = store.readWorkspace(resumed.reference.workspaceId);
      const snapshot = store.readBundle(
        resumed.reference.workspaceId,
        resumed.reference.revisionId,
      ).snapshot;
      expect(workspace).toMatchObject({
        currentRevisionId: resumed.reference.revisionId,
        repository: { root: realpathSync(root), name: repositoryName(root) },
        createdAt: snapshot.createdAt,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rescans and resumes when an identical revision wins a concurrent publish race', () => {
    const root = join(tmpdir(), `synergy-review-race-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    try {
      const durableStore = createReviewStore(realpathSync(root));
      let raced = false;
      const result = createOrResumeReview(createRequest(root), {
        createStore: () => ({
          ...durableStore,
          createRevision(workspace, snapshot, insights, progress): void {
            if (!raced) {
              raced = true;
              durableStore.createRevision(workspace, snapshot, insights, progress);
              throw new ReviewCoreError('review_conflict', 'injected concurrent publisher');
            }
            durableStore.createRevision(workspace, snapshot, insights, progress);
          },
        }),
      });

      expect(result.resumed).toBe(true);
      expect(raced).toBe(true);
      expect(
        durableStore.findRevisionByFingerprint(
          result.reference.workspaceId,
          durableStore.readBundle(result.reference.workspaceId, result.reference.revisionId)
            .snapshot.fingerprint,
        ),
      ).toBe(result.reference.revisionId);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('accepts one validated analysis payload and rejects duplicates', async () => {
    const root = join(tmpdir(), `synergy-review-analysis-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    try {
      const created = createOrResumeReview(createRequest(root));
      const snapshot = createReviewStore(root).readBundle(
        created.reference.workspaceId,
        created.reference.revisionId,
      ).snapshot;
      const reviewItemId = snapshot.items[0]?.id;
      if (!reviewItemId) throw new Error('fixture capture must create one review item');
      const analysis = {
        kind: 'diff' as const,
        groups: [{ id: 'core', label: 'Core change', reviewItemIds: [reviewItemId] }],
        items: [
          {
            reviewItemId,
            description: 'Updates the example value used by the staged module.',
            confidence: 'high' as const,
            evidencePaths: ['src/example.ts'],
          },
        ],
        removals: removalsForSnapshot(snapshot),
      };
      const result = await applyReviewAnalysis({
        root,
        reference: created.reference,
        analysis,
      });
      expect(result.reference).toBe(
        `${created.reference.workspaceId}@${created.reference.revisionId}`,
      );
      await expect(
        applyReviewAnalysis({
          root,
          reference: created.reference,
          analysis,
        }),
      ).rejects.toThrow(/already/i);
      expect(
        printReviewStatus({ root, reference: created.reference, runner: createRunner() }),
      ).toContain('needs review');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('persists summary and group intro for a diff analysis', async () => {
    const root = join(tmpdir(), `synergy-review-diff-narrative-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    try {
      const created = createOrResumeReview(createRequest(root));
      const snapshot = createReviewStore(root).readBundle(
        created.reference.workspaceId,
        created.reference.revisionId,
      ).snapshot;
      const reviewItemId = snapshot.items[0]?.id;
      if (!reviewItemId) throw new Error('fixture capture must create one review item');
      await applyReviewAnalysis({
        root,
        reference: created.reference,
        analysis: {
          kind: 'diff',
          summary: 'This PR adds rate limiting; middleware first, then the engine.',
          groups: [
            {
              id: 'core',
              label: 'Core change',
              intro: 'Every request passes through here first.',
              reviewItemIds: [reviewItemId],
            },
          ],
          items: [
            {
              reviewItemId,
              description: 'Updates the example value used by the staged module.',
              confidence: 'high',
              evidencePaths: ['src/example.ts'],
            },
          ],
          removals: removalsForSnapshot(snapshot),
        },
      });
      const finalized = createReviewStore(root).readBundle(
        created.reference.workspaceId,
        created.reference.revisionId,
      );
      expect(finalized.insights.summary).toBe(
        'This PR adds rate limiting; middleware first, then the engine.',
      );
      expect(finalized.insights.groups[0]?.intro).toBe('Every request passes through here first.');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('persists per-file descriptions supplied by analysis-set', async () => {
    const root = join(tmpdir(), `synergy-review-file-insights-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    try {
      const created = createOrResumeReview(createRequest(root));
      const snapshot = createReviewStore(root).readBundle(
        created.reference.workspaceId,
        created.reference.revisionId,
      ).snapshot;
      const reviewItemId = snapshot.items[0]?.id;
      if (!reviewItemId) throw new Error('fixture capture must create one review item');
      await applyReviewAnalysis({
        root,
        reference: created.reference,
        analysis: {
          kind: 'diff',
          groups: [{ id: 'core', label: 'Core change', reviewItemIds: [reviewItemId] }],
          items: [
            {
              reviewItemId,
              description: 'Updates the example value used by the staged module.',
              confidence: 'high',
              evidencePaths: ['src/example.ts'],
            },
          ],
          files: [
            {
              path: 'src/example.ts',
              description: 'Adjusts the exported example constant.',
              confidence: 'high',
            },
          ],
          removals: removalsForSnapshot(snapshot),
        },
      });
      const finalized = createReviewStore(root).readBundle(
        created.reference.workspaceId,
        created.reference.revisionId,
      );
      expect(finalized.insights.files).toEqual([
        {
          path: 'src/example.ts',
          description: 'Adjusts the exported example constant.',
          confidence: 'high',
        },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('carries file descriptions across a refresh and survives analysis without a files key', async () => {
    const root = join(tmpdir(), `synergy-review-file-carry-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    const twoFilePatch = (bValue: number): string =>
      [
        'diff --git a/src/a.ts b/src/a.ts',
        'index 1111111..2222222 100644',
        '--- a/src/a.ts',
        '+++ b/src/a.ts',
        '@@ -1 +1 @@',
        '-export const a = 1;',
        '+export const a = 2;',
        'diff --git a/src/b.ts b/src/b.ts',
        'index 3333333..4444444 100644',
        '--- a/src/b.ts',
        '+++ b/src/b.ts',
        '@@ -1 +1 @@',
        '-export const b = 1;',
        `+export const b = ${bValue};`,
        '',
      ].join('\n');
    let patch = twoFilePatch(2);
    const runner: CommandRunner = {
      run(command, args, options): CommandResult {
        const key = [command, ...args].join(' ');
        if (key === 'git diff --cached --no-ext-diff --binary') {
          return { exitCode: 0, stdout: patch, stderr: '' };
        }
        if (key === 'git rev-parse HEAD') return { exitCode: 0, stdout: 'abc123\n', stderr: '' };
        if (key === 'git rev-parse --show-toplevel') {
          return { exitCode: 0, stdout: `${options.cwd}\n`, stderr: '' };
        }
        if (key === 'git config --get remote.origin.url') {
          return { exitCode: 1, stdout: '', stderr: '' };
        }
        throw new Error(`missing fixture for ${key}`);
      },
    };
    try {
      const first = createOrResumeReview({ root, source: { kind: 'staged' }, runner });
      const store = createReviewStore(root);
      const firstSnapshot = store.readBundle(
        first.reference.workspaceId,
        first.reference.revisionId,
      ).snapshot;
      const itemA = firstSnapshot.items.find((item) => item.path === 'src/a.ts');
      const itemB = firstSnapshot.items.find((item) => item.path === 'src/b.ts');
      if (!itemA || !itemB) throw new Error('fixture capture must create two review items');

      await applyReviewAnalysis({
        root,
        reference: first.reference,
        analysis: {
          kind: 'diff',
          groups: [{ id: 'core', label: 'Core', reviewItemIds: [itemA.id, itemB.id] }],
          items: [
            {
              reviewItemId: itemA.id,
              description: 'Updates constant a.',
              confidence: 'high',
              evidencePaths: ['src/a.ts'],
            },
            {
              reviewItemId: itemB.id,
              description: 'Updates constant b.',
              confidence: 'high',
              evidencePaths: ['src/b.ts'],
            },
          ],
          files: [{ path: 'src/b.ts', description: 'File b summary.', confidence: 'high' }],
          removals: removalsForSnapshot(firstSnapshot),
        },
      });
      store.patchItemProgress(first.reference.workspaceId, first.reference.revisionId, itemB.id, {
        status: 'reviewed',
      });

      // Refresh: only file a's content changes; file b's hunk is byte-identical, so its review
      // item carries forward and its file insight should ride along into the new revision.
      patch = twoFilePatch(2).replace('export const a = 2;', 'export const a = 3;');
      const refreshed = createOrResumeReview({ root, source: { kind: 'staged' }, runner });
      expect(refreshed.reference.revisionId).not.toBe(first.reference.revisionId);
      const refreshedBundle = store.readBundle(
        refreshed.reference.workspaceId,
        refreshed.reference.revisionId,
      );
      expect(refreshedBundle.insights.files).toEqual([
        { path: 'src/b.ts', description: 'File b summary.', confidence: 'high' },
      ]);

      const refreshedItemA = refreshedBundle.snapshot.items.find(
        (item) => item.path === 'src/a.ts',
      );
      const refreshedItemB = refreshedBundle.snapshot.items.find(
        (item) => item.path === 'src/b.ts',
      );
      if (!refreshedItemA || !refreshedItemB) {
        throw new Error('refreshed snapshot must retain both review items');
      }

      // Finalize the refreshed revision without a files key: the carried file b description
      // must survive because analysis-set omitting `files` should not erase carried entries.
      await applyReviewAnalysis({
        root,
        reference: refreshed.reference,
        analysis: {
          kind: 'diff',
          groups: [
            { id: 'core', label: 'Core', reviewItemIds: [refreshedItemA.id, refreshedItemB.id] },
          ],
          items: [
            {
              reviewItemId: refreshedItemA.id,
              description: 'Updates constant a again.',
              confidence: 'high',
              evidencePaths: ['src/a.ts'],
            },
            {
              reviewItemId: refreshedItemB.id,
              description: 'Updates constant b.',
              confidence: 'high',
              evidencePaths: ['src/b.ts'],
            },
          ],
          removals: removalsForSnapshot(refreshedBundle.snapshot),
        },
      });
      const finalizedRefreshed = store.readBundle(
        refreshed.reference.workspaceId,
        refreshed.reference.revisionId,
      );
      expect(finalizedRefreshed.insights.files).toEqual([
        { path: 'src/b.ts', description: 'File b summary.', confidence: 'high' },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports durable analysis timing and keeps finalization successful when preview is unavailable', async () => {
    const root = join(tmpdir(), `synergy-review-analysis-result-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    try {
      const created = createOrResumeReview(createRequest(root));
      const store = createReviewStore(root);
      const snapshot = store.readBundle(
        created.reference.workspaceId,
        created.reference.revisionId,
      ).snapshot;
      const reviewItem = snapshot.items[0];
      if (!reviewItem) throw new Error('fixture capture must create one review item');
      const finalizedAt = new Date(Date.parse(snapshot.createdAt) + 210_000);
      const monotonicTicks = [0, 1, 3, 4, 7, 8, 13, 15];
      const monotonicNow = (): number => {
        const tick = monotonicTicks.shift();
        if (tick === undefined) throw new Error('unexpected monotonic clock read');
        return tick;
      };

      const result = await applyReviewAnalysis(
        {
          root,
          reference: created.reference,
          analysis: {
            kind: 'diff',
            groups: [{ id: 'core', label: 'Core', reviewItemIds: [reviewItem.id] }],
            items: [
              {
                reviewItemId: reviewItem.id,
                description: 'Updates the staged fixture in repository context.',
                confidence: 'high',
                evidencePaths: [reviewItem.path],
              },
            ],
            removals: removalsForSnapshot(snapshot),
          },
          parsingInMs: 7,
        },
        {
          now: () => finalizedAt,
          monotonicNow,
          previewStatus: async () => {
            throw new Error('preview runtime is unavailable');
          },
        },
      );

      expect(result).toEqual({
        reference: `${created.reference.workspaceId}@${created.reference.revisionId}`,
        analysisFinalized: true,
        reviewItemCount: 1,
        groupCount: 1,
        withinRecommendedRange: true,
        analysisFinalizedInMs: 210_000,
        route: `/r/${created.reference.workspaceId}/${created.reference.revisionId}`,
        previewReady: false,
        timings: {
          parsingMs: 7,
          derivationMs: 0,
          validationMs: 2,
          publicationMs: 3,
          previewResolutionMs: 5,
          totalMs: 22,
        },
      });
      expect(monotonicTicks).toEqual([]);
      expect(
        createReviewStore(root).getAnalysisFinalizedAt(
          created.reference.workspaceId,
          created.reference.revisionId,
        ),
      ).toBe(finalizedAt.toISOString());
      expect(
        createReviewStore(root).isAnalysisFinalized(
          created.reference.workspaceId,
          created.reference.revisionId,
        ),
      ).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns the immutable review URL when preview is healthy after finalization', async () => {
    const root = join(tmpdir(), `synergy-review-analysis-preview-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    try {
      const created = createOrResumeReview(createRequest(root));
      const snapshot = createReviewStore(root).readBundle(
        created.reference.workspaceId,
        created.reference.revisionId,
      ).snapshot;
      const reviewItem = snapshot.items[0];
      if (!reviewItem) throw new Error('fixture capture must create one review item');

      const result = await applyReviewAnalysis(
        {
          root,
          reference: created.reference,
          analysis: {
            kind: 'diff',
            groups: [{ id: 'core', label: 'Core', reviewItemIds: [reviewItem.id] }],
            items: [
              {
                reviewItemId: reviewItem.id,
                description: 'Updates the staged fixture in repository context.',
                confidence: 'high',
                evidencePaths: [reviewItem.path],
              },
            ],
            removals: removalsForSnapshot(snapshot),
          },
        },
        {
          now: () => new Date(0),
          previewStatus: async () => {
            expect(
              createReviewStore(root).isAnalysisFinalized(
                created.reference.workspaceId,
                created.reference.revisionId,
              ),
            ).toBe(true);
            return {
              running: true,
              pid: 123,
              port: 43_222,
              origin: 'http://127.0.0.1:43222',
              projectId: 'project-id',
              instanceId: 'instance-id',
            };
          },
        },
      );

      expect(result).toMatchObject({
        analysisFinalizedInMs: 0,
        previewReady: true,
        url: `http://127.0.0.1:43222/r/${created.reference.workspaceId}/${created.reference.revisionId}`,
      });
      expect(
        createReviewStore(root).getAnalysisFinalizedAt(
          created.reference.workspaceId,
          created.reference.revisionId,
        ),
      ).toBe(snapshot.createdAt);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('requires evidence from a captured file', async () => {
    const root = join(tmpdir(), `synergy-review-evidence-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    try {
      const created = createOrResumeReview(createRequest(root));
      const reviewItemId = createReviewStore(root).readBundle(
        created.reference.workspaceId,
        created.reference.revisionId,
      ).snapshot.items[0]?.id;
      if (!reviewItemId) throw new Error('fixture capture must create one review item');
      let nowCalls = 0;

      await expect(
        applyReviewAnalysis(
          {
            root,
            reference: created.reference,
            analysis: {
              kind: 'diff',
              groups: [{ id: 'core', label: 'Core change', reviewItemIds: [reviewItemId] }],
              items: [
                {
                  reviewItemId,
                  description: 'Updates the example value used by the staged module.',
                  confidence: 'high',
                  evidencePaths: ['src/not-captured.ts'],
                },
              ],
            },
          },
          {
            now: () => {
              nowCalls += 1;
              return new Date();
            },
          },
        ),
      ).rejects.toThrow(/captured/i);
      expect(nowCalls).toBe(0);
      expect(
        createReviewStore(root).getAnalysisFinalizedAt(
          created.reference.workspaceId,
          created.reference.revisionId,
        ),
      ).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('counts analysis description limits in Unicode code points', async () => {
    const roots = [
      join(tmpdir(), `synergy-review-unicode-accepted-${Date.now()}`),
      join(tmpdir(), `synergy-review-unicode-rejected-${Date.now()}`),
    ];
    for (const root of roots) mkdirSync(root, { recursive: true });
    try {
      const accepted = createOrResumeReview(createRequest(roots[0]!));
      const acceptedSnapshot = createReviewStore(roots[0]!).readBundle(
        accepted.reference.workspaceId,
        accepted.reference.revisionId,
      ).snapshot;
      const acceptedItem = acceptedSnapshot.items[0]!;
      await expect(
        applyReviewAnalysis({
          root: roots[0]!,
          reference: accepted.reference,
          analysis: {
            kind: 'diff',
            groups: [{ id: 'core', label: 'Core', reviewItemIds: [acceptedItem.id] }],
            items: [
              {
                reviewItemId: acceptedItem.id,
                description: '😀'.repeat(600),
                confidence: 'high',
                evidencePaths: [acceptedItem.path],
              },
            ],
            removals: removalsForSnapshot(acceptedSnapshot),
          },
        }),
      ).resolves.toMatchObject({ analysisFinalized: true });

      const rejected = createOrResumeReview(createRequest(roots[1]!));
      const rejectedStore = createReviewStore(roots[1]!);
      const rejectedItem = rejectedStore.readBundle(
        rejected.reference.workspaceId,
        rejected.reference.revisionId,
      ).snapshot.items[0]!;
      await expect(
        applyReviewAnalysis({
          root: roots[1]!,
          reference: rejected.reference,
          analysis: {
            kind: 'diff',
            groups: [{ id: 'core', label: 'Core', reviewItemIds: [rejectedItem.id] }],
            items: [
              {
                reviewItemId: rejectedItem.id,
                description: '😀'.repeat(601),
                confidence: 'high',
                evidencePaths: [rejectedItem.path],
              },
            ],
          },
        }),
      ).rejects.toThrow(/1-600 characters/i);
      expect(
        rejectedStore.isAnalysisFinalized(
          rejected.reference.workspaceId,
          rejected.reference.revisionId,
        ),
      ).toBe(false);
    } finally {
      for (const root of roots) rmSync(root, { recursive: true, force: true });
    }
  });

  it('opens an immutable revision at the verified preview runtime origin', async () => {
    const root = join(tmpdir(), `synergy-review-url-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    try {
      const created = createOrResumeReview(createRequest(root));
      let statusCalls = 0;

      const url = await openReview(root, created.reference, {
        previewStatus: async (requestedRoot) => {
          statusCalls += 1;
          expect(requestedRoot).toBe(root);
          return {
            running: true,
            pid: 123,
            port: 43_222,
            origin: 'http://127.0.0.1:43222',
            projectId: 'project-id',
            instanceId: 'instance-id',
          };
        },
      });

      expect(url).toBe(
        `http://127.0.0.1:43222/r/${created.reference.workspaceId}/${created.reference.revisionId}`,
      );
      expect(statusCalls).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns a typed corrective error without starting preview when no runtime is healthy', async () => {
    const root = join(tmpdir(), `Synergy Review No Runtime ${Date.now()}`);
    mkdirSync(root, { recursive: true });
    try {
      const created = createOrResumeReview(createRequest(root));
      let statusCalls = 0;

      await expect(
        openReview(root, created.reference, {
          previewStatus: async () => {
            statusCalls += 1;
            return {
              running: false,
              pid: null,
              port: null,
              origin: null,
              projectId: 'project-id',
              instanceId: null,
            };
          },
        }),
      ).rejects.toMatchObject({
        code: 'preview_not_ready',
        root,
        message: `Preview is not ready for project root ${JSON.stringify(root)}. Invoke the Synergy executable with argv ${JSON.stringify(['preview', 'start', '--root', root])}.`,
        suggestedCommand: {
          command: 'synergy',
          args: ['preview', 'start', '--root', root],
        },
      });
      expect(statusCalls).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps adversarial project roots in argv data instead of executable shell text', () => {
    const root = '/tmp/$(touch PWNED); `touch ALSO_PWNED`; "quoted"';
    const error = new PreviewNotReadyError(root);

    expect(error.message).toBe(
      `Preview is not ready for project root ${JSON.stringify(root)}. Invoke the Synergy executable with argv ${JSON.stringify(['preview', 'start', '--root', root])}.`,
    );
    expect(error.message).not.toContain('synergy preview start --root');
    expect(error.suggestedCommand).toEqual({
      command: 'synergy',
      args: ['preview', 'start', '--root', root],
    });
  });

  it('validates the requested review bundle before checking preview status', async () => {
    const root = join(tmpdir(), `synergy-review-missing-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    let statusChecked = false;
    try {
      await expect(
        openReview(
          root,
          { workspaceId: 'missing-workspace', revisionId: 'missing-revision' },
          {
            previewStatus: async () => {
              statusChecked = true;
              throw new PreviewNotReadyError(root);
            },
          },
        ),
      ).rejects.toMatchObject({ code: 'review_not_found' });
      expect(statusChecked).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses the canonical Git root so a nested invocation resumes the same workspace', () => {
    const root = join(tmpdir(), `synergy-review-root-${Date.now()}`);
    const nested = join(root, 'src', 'nested');
    mkdirSync(nested, { recursive: true });
    const runner: CommandRunner = {
      run(command, args): CommandResult {
        const key = [command, ...args].join(' ');
        if (key === 'git rev-parse --show-toplevel') {
          return { exitCode: 0, stdout: `${root}\n`, stderr: '' };
        }
        if (key === 'git diff --cached --no-ext-diff --binary') {
          return { exitCode: 0, stdout: PATCH, stderr: '' };
        }
        if (key === 'git rev-parse HEAD') return { exitCode: 0, stdout: 'abc123\n', stderr: '' };
        throw new Error(`missing fixture for ${key}`);
      },
    };
    try {
      const first = createOrResumeReview({ root, source: { kind: 'staged' }, runner });
      const resumed = createOrResumeReview({ root: nested, source: { kind: 'staged' }, runner });
      expect(resumed.reference).toEqual(first.reference);
      expect(resumed.resumed).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('moves the workspace pointer back when an older exact fingerprint resumes', () => {
    const root = join(tmpdir(), `synergy-review-pointer-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    let patch = PATCH;
    const runner: CommandRunner = {
      run(command, args, options): CommandResult {
        const key = [command, ...args].join(' ');
        if (key === 'git rev-parse --show-toplevel') {
          return { exitCode: 0, stdout: `${options.cwd}\n`, stderr: '' };
        }
        if (key === 'git diff --cached --no-ext-diff --binary') {
          return { exitCode: 0, stdout: patch, stderr: '' };
        }
        if (key === 'git rev-parse HEAD') return { exitCode: 0, stdout: 'abc123\n', stderr: '' };
        throw new Error(`missing fixture for ${key}`);
      },
    };
    try {
      const first = createOrResumeReview({ root, source: { kind: 'staged' }, runner });
      patch = PATCH.replace('value = 2', 'value = 3');
      const second = createOrResumeReview({ root, source: { kind: 'staged' }, runner });
      patch = PATCH;
      const resumed = createOrResumeReview({ root, source: { kind: 'staged' }, runner });
      const workspace = createReviewStore(root).readWorkspace(first.reference.workspaceId);
      expect(second.reference.revisionId).not.toBe(first.reference.revisionId);
      expect(resumed.reference).toEqual(first.reference);
      expect(workspace.currentRevisionId).toBe(first.reference.revisionId);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('finalizes scoped snapshots from proposed code sections exactly once', async () => {
    const root = join(tmpdir(), `synergy-review-scope-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    const runner: CommandRunner = {
      run(command, args, options): CommandResult {
        const key = [command, ...args].join(' ');
        if (key === 'git rev-parse --show-toplevel') {
          return { exitCode: 0, stdout: `${options.cwd}\n`, stderr: '' };
        }
        if (key === 'git rev-parse HEAD') return { exitCode: 0, stdout: 'abc123\n', stderr: '' };
        if (key === 'git ls-files --cached --others --exclude-standard -z -- src') {
          return { exitCode: 0, stdout: 'src/example.ts\0', stderr: '' };
        }
        throw new Error(`missing fixture for ${key}`);
      },
    };
    try {
      const source = 'export const first = 1;\nexport const second = 2;\n';
      const created = createOrResumeReview({
        root,
        runner,
        readFile: () => source,
        source: { kind: 'scope', patterns: ['src'] },
      });
      const before = createReviewStore(root).readBundle(
        created.reference.workspaceId,
        created.reference.revisionId,
      );
      expect(before.snapshot.items).toEqual([]);
      expect(created).toMatchObject({
        analysisGuidance: {
          textFiles: 1,
          textLines: 3,
          minimumSections: 1,
          targetSections: 1,
          maximumSections: 1,
          scopeTooBroad: false,
        },
      });
      expect(
        JSON.parse(
          formatReviewStatusJson({
            root,
            reference: created.reference,
            runner,
            readFile: () => source,
          }),
        ),
      ).toMatchObject({
        analysisRequired: true,
        analysisGuidance: {
          textFiles: 1,
          textLines: 3,
          minimumSections: 1,
          targetSections: 1,
          maximumSections: 1,
          scopeTooBroad: false,
        },
        readiness: { ready: false, preparing: true, pending: 0 },
      });
      await expect(
        applyReviewAnalysis({
          root,
          reference: created.reference,
          analysis: { kind: 'diff', groups: [], items: [] },
        }),
      ).rejects.toThrow(/scope analysis payload/i);
      expect(
        createReviewStore(root).isAnalysisFinalized(
          created.reference.workspaceId,
          created.reference.revisionId,
        ),
      ).toBe(false);
      const section = {
        key: 'local-key-not-persisted',
        path: 'src/example.ts',
        label: 'Module exports',
        start: 1,
        end: 3,
        description: 'Defines the scoped exports consumed by the module.',
        confidence: 'high' as const,
        evidencePaths: ['src/example.ts'],
      };

      let applySectionsCalls = 0;
      const applySections = (
        ...args: Parameters<typeof applyCoreCodeSections>
      ): ReturnType<typeof applyCoreCodeSections> => {
        applySectionsCalls += 1;
        expect(args[1]).toEqual([
          {
            path: section.path,
            label: section.label,
            start: section.start,
            end: section.end,
          },
        ]);
        return applyCoreCodeSections(...args);
      };

      await expect(
        applyReviewAnalysis(
          {
            root,
            reference: created.reference,
            analysis: {
              kind: 'scope',
              sections: [{ ...section, end: 2 }],
              groups: [{ id: 'exports', label: 'Exports', sectionKeys: [section.key] }],
            },
          },
          { applyCodeSections: applySections },
        ),
      ).rejects.toThrow(/trailing gap/i);
      expect(applySectionsCalls).toBe(0);

      await expect(
        applyReviewAnalysis(
          {
            root,
            reference: created.reference,
            analysis: {
              kind: 'scope',
              sections: [section],
              groups: [{ id: 'exports', label: 'Exports', sectionKeys: ['unknown-local-key'] }],
            },
          },
          { applyCodeSections: applySections },
        ),
      ).rejects.toThrow(/unknown scope section key/i);
      expect(applySectionsCalls).toBe(1);

      await expect(
        applyReviewAnalysis(
          {
            root,
            reference: created.reference,
            analysis: {
              kind: 'scope',
              sections: [section],
              groups: [
                { id: 'exports', label: 'Exports', sectionKeys: [section.key] },
                { id: 'duplicate', label: 'Duplicate', sectionKeys: [section.key] },
              ],
            },
          },
          { applyCodeSections: applySections },
        ),
      ).rejects.toThrow(/multiple groups/i);
      expect(applySectionsCalls).toBe(2);
      expect(
        createReviewStore(root).isAnalysisFinalized(
          created.reference.workspaceId,
          created.reference.revisionId,
        ),
      ).toBe(false);
      expect(
        createReviewStore(root).getAnalysisFinalizedAt(
          created.reference.workspaceId,
          created.reference.revisionId,
        ),
      ).toBeUndefined();

      const scopeFinalizedAt = new Date(Date.parse(before.snapshot.createdAt) + 5_000);
      const result = await applyReviewAnalysis(
        {
          root,
          reference: created.reference,
          analysis: {
            kind: 'scope',
            sections: [section],
            groups: [{ id: 'exports', label: 'Exports', sectionKeys: [section.key] }],
          },
        },
        { applyCodeSections: applySections, now: () => scopeFinalizedAt },
      );
      expect(result).toMatchObject({
        analysisFinalized: true,
        reviewItemCount: 1,
        groupCount: 1,
        withinRecommendedRange: true,
        analysisFinalizedInMs: 5_000,
      });
      expect(applySectionsCalls).toBe(3);
      const finalized = createReviewStore(root).readBundle(
        created.reference.workspaceId,
        created.reference.revisionId,
      );
      expect(finalized.snapshot.items).toHaveLength(1);
      expect(
        createReviewStore(root).getAnalysisFinalizedAt(
          created.reference.workspaceId,
          created.reference.revisionId,
        ),
      ).toBe(scopeFinalizedAt.toISOString());
      expect(finalized.insights).toEqual({
        schemaVersion: 1,
        revisionId: created.reference.revisionId,
        groups: [
          {
            id: 'exports',
            label: 'Exports',
            reviewItemIds: [finalized.snapshot.items[0]!.id],
          },
        ],
        items: [
          {
            reviewItemId: finalized.snapshot.items[0]!.id,
            description: section.description,
            confidence: section.confidence,
            evidencePaths: section.evidencePaths,
          },
        ],
      });
      expect(JSON.stringify(finalized)).not.toContain(section.key);
      expect(
        JSON.parse(
          formatReviewStatusJson({
            root,
            reference: created.reference,
            runner,
            readFile: () => source,
          }),
        ),
      ).toMatchObject({
        analysisRequired: false,
        readiness: { ready: false, preparing: false, pending: 1 },
      });
      await expect(
        applyReviewAnalysis({
          root,
          reference: created.reference,
          analysis: { kind: 'scope', sections: [section], groups: [] },
        }),
      ).rejects.toThrow(/already/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('persists scope file descriptions and rejects an unknown scope file path', async () => {
    const root = join(tmpdir(), `synergy-review-scope-files-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    const runner: CommandRunner = {
      run(command, args, options): CommandResult {
        const key = [command, ...args].join(' ');
        if (key === 'git rev-parse --show-toplevel') {
          return { exitCode: 0, stdout: `${options.cwd}\n`, stderr: '' };
        }
        if (key === 'git rev-parse HEAD') return { exitCode: 0, stdout: 'abc123\n', stderr: '' };
        if (key === 'git ls-files --cached --others --exclude-standard -z -- src') {
          return { exitCode: 0, stdout: 'src/example.ts\0', stderr: '' };
        }
        throw new Error(`missing fixture for ${key}`);
      },
    };
    try {
      const source = 'export const first = 1;\nexport const second = 2;\n';
      const created = createOrResumeReview({
        root,
        runner,
        readFile: () => source,
        source: { kind: 'scope', patterns: ['src'] },
      });
      const section = {
        key: 'local-key',
        path: 'src/example.ts',
        label: 'Module exports',
        start: 1,
        end: 3,
        description: 'Defines the scoped exports consumed by the module.',
        confidence: 'high' as const,
        evidencePaths: ['src/example.ts'],
      };

      await expect(
        applyReviewAnalysis({
          root,
          reference: created.reference,
          analysis: {
            kind: 'scope',
            sections: [section],
            groups: [{ id: 'exports', label: 'Exports', sectionKeys: [section.key] }],
            files: [{ path: 'src/missing.ts', description: 'Unknown file.', confidence: 'low' }],
          },
        }),
      ).rejects.toThrow(/unknown path/i);
      expect(
        createReviewStore(root).isAnalysisFinalized(
          created.reference.workspaceId,
          created.reference.revisionId,
        ),
      ).toBe(false);

      await applyReviewAnalysis({
        root,
        reference: created.reference,
        analysis: {
          kind: 'scope',
          sections: [section],
          groups: [{ id: 'exports', label: 'Exports', sectionKeys: [section.key] }],
          files: [
            { path: 'src/example.ts', description: 'Exports two constants.', confidence: 'high' },
          ],
        },
      });
      const finalized = createReviewStore(root).readBundle(
        created.reference.workspaceId,
        created.reference.revisionId,
      );
      expect(finalized.insights.files).toEqual([
        { path: 'src/example.ts', description: 'Exports two constants.', confidence: 'high' },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('persists summary and group intro for a scope analysis', async () => {
    const root = join(tmpdir(), `synergy-review-scope-narrative-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    const runner: CommandRunner = {
      run(command, args, options): CommandResult {
        const key = [command, ...args].join(' ');
        if (key === 'git rev-parse --show-toplevel') {
          return { exitCode: 0, stdout: `${options.cwd}\n`, stderr: '' };
        }
        if (key === 'git rev-parse HEAD') return { exitCode: 0, stdout: 'abc123\n', stderr: '' };
        if (key === 'git ls-files --cached --others --exclude-standard -z -- src') {
          return { exitCode: 0, stdout: 'src/example.ts\0', stderr: '' };
        }
        throw new Error(`missing fixture for ${key}`);
      },
    };
    try {
      const source = 'export const first = 1;\nexport const second = 2;\n';
      const created = createOrResumeReview({
        root,
        runner,
        readFile: () => source,
        source: { kind: 'scope', patterns: ['src'] },
      });
      const section = {
        key: 'local-key',
        path: 'src/example.ts',
        label: 'Module exports',
        start: 1,
        end: 3,
        description: 'Defines the scoped exports consumed by the module.',
        confidence: 'high' as const,
        evidencePaths: ['src/example.ts'],
      };

      await applyReviewAnalysis({
        root,
        reference: created.reference,
        analysis: {
          kind: 'scope',
          summary: 'Walks the subscription lifecycle.',
          sections: [section],
          groups: [
            {
              id: 'exports',
              label: 'Exports',
              intro: 'Capture comes before projection.',
              sectionKeys: [section.key],
            },
          ],
        },
      });
      const finalized = createReviewStore(root).readBundle(
        created.reference.workspaceId,
        created.reference.revisionId,
      );
      expect(finalized.insights.summary).toBe('Walks the subscription lifecycle.');
      expect(finalized.insights.groups[0]?.intro).toBe('Capture comes before projection.');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('carries scope file descriptions across a refresh, and fresh analysis wins when provided', async () => {
    const root = join(tmpdir(), `synergy-review-scope-file-carry-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    let contentA = 'export const a = 1;\n';
    const contentB = 'export const b = 1;\n';
    const runner: CommandRunner = {
      run(command, args, options): CommandResult {
        const key = [command, ...args].join(' ');
        if (key === 'git rev-parse --show-toplevel') {
          return { exitCode: 0, stdout: `${options.cwd}\n`, stderr: '' };
        }
        if (key === 'git rev-parse HEAD') return { exitCode: 0, stdout: 'abc123\n', stderr: '' };
        if (key === 'git ls-files --cached --others --exclude-standard -z -- src') {
          return { exitCode: 0, stdout: 'src/a.ts\0src/b.ts\0', stderr: '' };
        }
        throw new Error(`missing fixture for ${key}`);
      },
    };
    const readFile = (path: string): string => (path.endsWith('a.ts') ? contentA : contentB);
    const sectionA = {
      key: 'section-a',
      path: 'src/a.ts',
      label: 'Constant a',
      start: 1,
      end: 2,
      description: 'Defines constant a.',
      confidence: 'high' as const,
      evidencePaths: ['src/a.ts'],
    };
    const sectionB = {
      key: 'section-b',
      path: 'src/b.ts',
      label: 'Constant b',
      start: 1,
      end: 2,
      description: 'Defines constant b.',
      confidence: 'high' as const,
      evidencePaths: ['src/b.ts'],
    };
    const groups = [{ id: 'exports', label: 'Exports', sectionKeys: [sectionA.key, sectionB.key] }];
    try {
      const store = createReviewStore(root);

      // Revision 1: describe both files, then mark file b's item reviewed so its insight
      // becomes carryable across refreshes.
      const first = createOrResumeReview({
        root,
        runner,
        readFile,
        source: { kind: 'scope', patterns: ['src'] },
      });
      await applyReviewAnalysis({
        root,
        reference: first.reference,
        analysis: {
          kind: 'scope',
          sections: [sectionA, sectionB],
          groups,
          files: [{ path: 'src/b.ts', description: 'File b summary.', confidence: 'high' }],
        },
      });
      const firstBundle = store.readBundle(first.reference.workspaceId, first.reference.revisionId);
      const firstItemB = firstBundle.snapshot.items.find((item) => item.path === 'src/b.ts');
      if (!firstItemB) throw new Error('fixture must create an item for src/b.ts');
      store.patchItemProgress(
        first.reference.workspaceId,
        first.reference.revisionId,
        firstItemB.id,
        {
          status: 'reviewed',
        },
      );

      // Revision 2 (refresh): only file a's content changes, so file b's section carries
      // forward untouched. Finalize without a `files` key - the carried description for
      // file b must survive even though fresh analysis omits it.
      contentA = 'export const a = 2;\n';
      const second = createOrResumeReview({
        root,
        runner,
        readFile,
        source: { kind: 'scope', patterns: ['src'] },
      });
      expect(second.reference.revisionId).not.toBe(first.reference.revisionId);
      await applyReviewAnalysis({
        root,
        reference: second.reference,
        analysis: { kind: 'scope', sections: [sectionA, sectionB], groups },
      });
      const secondBundle = store.readBundle(
        second.reference.workspaceId,
        second.reference.revisionId,
      );
      expect(secondBundle.insights.files).toEqual([
        { path: 'src/b.ts', description: 'File b summary.', confidence: 'high' },
      ]);
      const secondItemB = secondBundle.snapshot.items.find((item) => item.path === 'src/b.ts');
      if (!secondItemB) throw new Error('refreshed snapshot must retain the item for src/b.ts');
      expect(secondBundle.progress.items[secondItemB.id]?.status).toBe('carried-forward');

      // Revision 3 (second refresh): file a changes again, file b still carries forward, but
      // this time fresh analysis provides a file b description - it must win over the carried one.
      contentA = 'export const a = 3;\n';
      const third = createOrResumeReview({
        root,
        runner,
        readFile,
        source: { kind: 'scope', patterns: ['src'] },
      });
      expect(third.reference.revisionId).not.toBe(second.reference.revisionId);
      await applyReviewAnalysis({
        root,
        reference: third.reference,
        analysis: {
          kind: 'scope',
          sections: [sectionA, sectionB],
          groups,
          files: [{ path: 'src/b.ts', description: 'Updated file b summary.', confidence: 'high' }],
        },
      });
      const thirdBundle = store.readBundle(third.reference.workspaceId, third.reference.revisionId);
      expect(thirdBundle.insights.files).toEqual([
        { path: 'src/b.ts', description: 'Updated file b summary.', confidence: 'high' },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('persists removal rationales onto the finalized diff insights', async () => {
    const root = join(tmpdir(), `synergy-review-removals-persist-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    try {
      const created = createOrResumeReview(createRequest(root));
      const store = createReviewStore(root);
      const snapshot = store.readBundle(
        created.reference.workspaceId,
        created.reference.revisionId,
      ).snapshot;
      const item = snapshot.items[0]!;
      const removals = removalsForSnapshot(snapshot);
      expect(removals).toHaveLength(1);
      await applyReviewAnalysis({
        root,
        reference: created.reference,
        analysis: {
          kind: 'diff',
          groups: [{ id: 'core', label: 'Core', reviewItemIds: [item.id] }],
          items: [
            {
              reviewItemId: item.id,
              description: 'Updates the staged fixture value.',
              confidence: 'high',
              evidencePaths: [item.path],
            },
          ],
          removals,
        },
      });
      const finalized = store.readBundle(
        created.reference.workspaceId,
        created.reference.revisionId,
      );
      expect(finalized.insights.removals).toEqual(removals);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a diff analysis that omits a rationale for a captured removal', async () => {
    const root = join(tmpdir(), `synergy-review-removals-incomplete-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    try {
      const created = createOrResumeReview(createRequest(root));
      const store = createReviewStore(root);
      const snapshot = store.readBundle(
        created.reference.workspaceId,
        created.reference.revisionId,
      ).snapshot;
      const item = snapshot.items[0]!;
      await expect(
        applyReviewAnalysis({
          root,
          reference: created.reference,
          analysis: {
            kind: 'diff',
            groups: [{ id: 'core', label: 'Core', reviewItemIds: [item.id] }],
            items: [
              {
                reviewItemId: item.id,
                description: 'Updates the staged fixture value.',
                confidence: 'high',
                evidencePaths: [item.path],
              },
            ],
            // Missing `removals` entirely - the captured hunk includes a one-line removal run.
          },
        }),
      ).rejects.toThrow(/removal runs are missing a rationale/);
      expect(
        store.isAnalysisFinalized(created.reference.workspaceId, created.reference.revisionId),
      ).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("resolves a moved-to excerpt for a staged review by reading git's index", async () => {
    const root = join(tmpdir(), `synergy-review-removals-excerpt-staged-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    try {
      const calls: string[] = [];
      const fixture: CommandRunner = {
        run(command, args, options): CommandResult {
          const key = [command, ...args].join(' ');
          if (key === 'git show :src/other.ts') {
            return { exitCode: 0, stdout: 'l1\nl2\nl3\nl4\nl5\nl6\n', stderr: '' };
          }
          return createRunner().run(command, args, options);
        },
      };
      const runner = recordingRunner(fixture, calls);
      const created = createOrResumeReview({ root, source: { kind: 'staged' }, runner });
      const store = createReviewStore(root);
      const snapshot = store.readBundle(
        created.reference.workspaceId,
        created.reference.revisionId,
      ).snapshot;
      const item = snapshot.items[0]!;
      const removals = movedOutsideRationale(snapshot, item.id, {
        path: 'src/other.ts',
        start: 5,
        end: 6,
      });
      await applyReviewAnalysis({
        root,
        reference: created.reference,
        analysis: {
          kind: 'diff',
          groups: [{ id: 'core', label: 'Core', reviewItemIds: [item.id] }],
          items: [
            {
              reviewItemId: item.id,
              description: 'Updates the staged fixture value.',
              confidence: 'high',
              evidencePaths: [item.path],
            },
          ],
          removals,
        },
        runner,
      });
      const finalized = store.readBundle(
        created.reference.workspaceId,
        created.reference.revisionId,
      );
      expect(finalized.insights.removals?.[0]?.movedToExcerpt).toEqual({
        path: 'src/other.ts',
        start: 5,
        lines: ['l5', 'l6'],
      });
      // The staged read seam must ask git for the indexed blob (":<path>"), not the worktree.
      expect(calls).toContain('git show :src/other.ts');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('resolves a moved-to excerpt for a PR review by reading the head commit', async () => {
    const root = join(tmpdir(), `synergy-review-removals-excerpt-pr-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    try {
      const metadata = JSON.stringify({
        number: 42,
        title: 'Moved logic',
        url: 'https://github.com/acme/repo/pull/42',
        baseRefOid: 'base123',
        headRefOid: 'head123',
      });
      const calls: string[] = [];
      const fixture: CommandRunner = {
        run(command, args, options): CommandResult {
          const key = [command, ...args].join(' ');
          if (key === 'gh pr view 42 --json number,title,url,baseRefOid,headRefOid') {
            return { exitCode: 0, stdout: metadata, stderr: '' };
          }
          if (key === 'gh pr diff https://github.com/acme/repo/pull/42') {
            return { exitCode: 0, stdout: PATCH, stderr: '' };
          }
          if (
            key ===
            'gh pr view https://github.com/acme/repo/pull/42 --json number,title,url,baseRefOid,headRefOid'
          ) {
            return { exitCode: 0, stdout: metadata, stderr: '' };
          }
          if (key === 'git rev-parse --show-toplevel') {
            return { exitCode: 0, stdout: `${options.cwd}\n`, stderr: '' };
          }
          if (key === 'git show head123:src/other.ts') {
            return { exitCode: 0, stdout: 'l1\nl2\nl3\nl4\nl5\nl6\n', stderr: '' };
          }
          throw new Error(`missing fixture for ${key}`);
        },
      };
      const runner = recordingRunner(fixture, calls);
      const created = createOrResumeReview({
        root,
        source: { kind: 'pr', selector: '42' },
        runner,
      });
      const store = createReviewStore(root);
      const snapshot = store.readBundle(
        created.reference.workspaceId,
        created.reference.revisionId,
      ).snapshot;
      const item = snapshot.items[0]!;
      const removals = movedOutsideRationale(snapshot, item.id, {
        path: 'src/other.ts',
        start: 5,
        end: 6,
      });
      await applyReviewAnalysis({
        root,
        reference: created.reference,
        analysis: {
          kind: 'diff',
          groups: [{ id: 'core', label: 'Core', reviewItemIds: [item.id] }],
          items: [
            {
              reviewItemId: item.id,
              description: 'Updates the PR fixture value.',
              confidence: 'high',
              evidencePaths: [item.path],
            },
          ],
          removals,
        },
        runner,
      });
      const finalized = store.readBundle(
        created.reference.workspaceId,
        created.reference.revisionId,
      );
      expect(finalized.insights.removals?.[0]?.movedToExcerpt).toEqual({
        path: 'src/other.ts',
        start: 5,
        lines: ['l5', 'l6'],
      });
      // The PR read seam must pin to the captured head SHA, not the (possibly since-moved) branch tip.
      expect(calls).toContain('git show head123:src/other.ts');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('resolves a moved-to excerpt for an unstaged review by reading the worktree file', async () => {
    const root = join(tmpdir(), `synergy-review-removals-excerpt-unstaged-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    const unstagedDiffCommand = [
      'git',
      'diff',
      '--no-ext-diff',
      '--binary',
      '--',
      ':(exclude).synergy/preview.runtime.json',
      ':(exclude).synergy/preview.runtime.json.*',
      ':(exclude).synergy/.preview.runtime.json.*.tmp',
      ':(exclude).synergy/preview.start.lock',
      ':(exclude).synergy/preview.start.lock.*',
      ':(exclude).synergy/preview.pid',
      ':(exclude).synergy/preview.log',
    ].join(' ');
    try {
      const calls: string[] = [];
      const fixture: CommandRunner = {
        run(command, args, options): CommandResult {
          const key = [command, ...args].join(' ');
          if (key === 'git rev-parse --show-toplevel') {
            return { exitCode: 0, stdout: `${options.cwd}\n`, stderr: '' };
          }
          if (key === 'git rev-parse HEAD') return { exitCode: 0, stdout: 'abc123\n', stderr: '' };
          if (key === unstagedDiffCommand) return { exitCode: 0, stdout: PATCH, stderr: '' };
          if (key === 'git ls-files --others --exclude-standard -z') {
            return { exitCode: 0, stdout: '', stderr: '' };
          }
          throw new Error(`missing fixture for ${key}`);
        },
      };
      const runner = recordingRunner(fixture, calls);
      const created = createOrResumeReview({
        root,
        source: { kind: 'unstaged' },
        runner,
        readFile: () => 'unused',
      });
      const store = createReviewStore(root);
      const snapshot = store.readBundle(
        created.reference.workspaceId,
        created.reference.revisionId,
      ).snapshot;
      const item = snapshot.items[0]!;
      const removals = movedOutsideRationale(snapshot, item.id, {
        path: 'src/other.ts',
        start: 5,
        end: 6,
      });
      const targetPath = join(root, 'src/other.ts');
      await applyReviewAnalysis({
        root,
        reference: created.reference,
        analysis: {
          kind: 'diff',
          groups: [{ id: 'core', label: 'Core', reviewItemIds: [item.id] }],
          items: [
            {
              reviewItemId: item.id,
              description: 'Updates the unstaged fixture value.',
              confidence: 'high',
              evidencePaths: [item.path],
            },
          ],
          removals,
        },
        runner,
        readFile: (path) => (path === targetPath ? 'l1\nl2\nl3\nl4\nl5\nl6\n' : undefined),
      });
      const finalized = store.readBundle(
        created.reference.workspaceId,
        created.reference.revisionId,
      );
      expect(finalized.insights.removals?.[0]?.movedToExcerpt).toEqual({
        path: 'src/other.ts',
        start: 5,
        lines: ['l5', 'l6'],
      });
      // Unstaged has no immutable Git pointer to read from, so the seam must be the worktree file
      // (via readFile), never a git show.
      expect(calls.some((call) => call.startsWith('git show'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects analysis end-to-end when a moved-to target file cannot be read', async () => {
    const root = join(tmpdir(), `synergy-review-removals-excerpt-missing-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    try {
      const runner: CommandRunner = {
        run(command, args, options): CommandResult {
          const key = [command, ...args].join(' ');
          if (key === 'git show :src/missing.ts') {
            return { exitCode: 1, stdout: '', stderr: 'fatal: path does not exist' };
          }
          return createRunner().run(command, args, options);
        },
      };
      const created = createOrResumeReview({ root, source: { kind: 'staged' }, runner });
      const store = createReviewStore(root);
      const snapshot = store.readBundle(
        created.reference.workspaceId,
        created.reference.revisionId,
      ).snapshot;
      const item = snapshot.items[0]!;
      const removals = movedOutsideRationale(snapshot, item.id, {
        path: 'src/missing.ts',
        start: 1,
        end: 2,
      });
      await expect(
        applyReviewAnalysis({
          root,
          reference: created.reference,
          analysis: {
            kind: 'diff',
            groups: [{ id: 'core', label: 'Core', reviewItemIds: [item.id] }],
            items: [
              {
                reviewItemId: item.id,
                description: 'Updates the staged fixture value.',
                confidence: 'high',
                evidencePaths: [item.path],
              },
            ],
            removals,
          },
          runner,
        }),
      ).rejects.toThrow(/movedTo target was not found/);
      expect(
        store.isAnalysisFinalized(created.reference.workspaceId, created.reference.revisionId),
      ).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects analysis end-to-end when a moved-to target range exceeds the file', async () => {
    const root = join(tmpdir(), `synergy-review-removals-excerpt-oversized-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    try {
      const runner: CommandRunner = {
        run(command, args, options): CommandResult {
          const key = [command, ...args].join(' ');
          if (key === 'git show :src/other.ts') {
            return { exitCode: 0, stdout: 'only one line\n', stderr: '' };
          }
          return createRunner().run(command, args, options);
        },
      };
      const created = createOrResumeReview({ root, source: { kind: 'staged' }, runner });
      const store = createReviewStore(root);
      const snapshot = store.readBundle(
        created.reference.workspaceId,
        created.reference.revisionId,
      ).snapshot;
      const item = snapshot.items[0]!;
      const removals = movedOutsideRationale(snapshot, item.id, {
        path: 'src/other.ts',
        start: 5,
        end: 6,
      });
      await expect(
        applyReviewAnalysis({
          root,
          reference: created.reference,
          analysis: {
            kind: 'diff',
            groups: [{ id: 'core', label: 'Core', reviewItemIds: [item.id] }],
            items: [
              {
                reviewItemId: item.id,
                description: 'Updates the staged fixture value.',
                confidence: 'high',
                evidencePaths: [item.path],
              },
            ],
            removals,
          },
          runner,
        }),
      ).rejects.toThrow(/is out of range/);
      expect(
        store.isAnalysisFinalized(created.reference.workspaceId, created.reference.revisionId),
      ).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  describe('review path exclusions', () => {
    it('omits excludes and excludedFileCount from results when none are configured', () => {
      const root = join(tmpdir(), `synergy-review-excludes-absent-${Date.now()}`);
      mkdirSync(root, { recursive: true });
      try {
        const created = createOrResumeReview(createRequest(root));
        expect(created.excludes).toBeUndefined();
        expect(created.excludedFileCount).toBeUndefined();
        const status = getReviewStatus({
          root,
          reference: created.reference,
          runner: createRunner(),
        });
        expect(status.excludes).toBeUndefined();
        expect(
          printReviewStatus({ root, reference: created.reference, runner: createRunner() }),
        ).not.toMatch(/excludes:/);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    // Previously fixture-based with a single excluded file, which passed regardless of whether
    // `excludedFileCount` was actually counted correctly - staged capture happens to skip git
    // pathspecs entirely (see path-excludes.ts / CLAUDE.md), so a fixture with exactly one
    // excluded chunk cannot distinguish "counts every excluded file" from "always reports 1"
    // (I5). A real repository with TWO excluded files under two different exclude patterns
    // actually exercises the count.
    it('echoes active exclusions in create and status results and reports what was dropped', () => {
      const root = join(tmpdir(), `synergy-review-excludes-present-${Date.now()}`);
      try {
        createRealRepository(root);
        mkdirSync(join(root, '.vouch'), { recursive: true });
        mkdirSync(join(root, 'dist'), { recursive: true });
        writeFileSync(join(root, '.vouch', 'report.md'), 'v1\n');
        writeFileSync(join(root, 'dist', 'bundle.js'), 'v1\n');
        writeFileSync(join(root, 'src.ts'), 'export const value = 1;\n');
        git(root, 'add', '.');
        git(root, 'commit', '--quiet', '-m', 'base');

        writeFileSync(join(root, '.vouch', 'report.md'), 'v2\n');
        writeFileSync(join(root, 'dist', 'bundle.js'), 'v2\n');
        writeFileSync(join(root, 'src.ts'), 'export const value = 2;\n');
        git(root, 'add', '.');

        const created = createOrResumeReview({
          root,
          source: { kind: 'staged', excludes: ['.vouch', 'dist'] },
        });
        expect(created.excludes).toEqual(['.vouch', 'dist']);
        expect(created.excludedFileCount).toBe(2);

        const store = createReviewStore(root);
        const bundle = store.readBundle(
          created.reference.workspaceId,
          created.reference.revisionId,
        );
        if (bundle.snapshot.kind !== 'diff') throw new Error('expected a diff snapshot');
        expect(bundle.snapshot.files.map((file) => file.path)).toEqual(['src.ts']);
        expect(bundle.snapshot.source.excludes).toEqual(['.vouch', 'dist']);

        const status = getReviewStatus({ root, reference: created.reference });
        expect(status.excludes).toEqual(['.vouch', 'dist']);
        expect(printReviewStatus({ root, reference: created.reference })).toContain(
          'excludes: .vouch, dist',
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });
});
