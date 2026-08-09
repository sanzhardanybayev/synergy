import { mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ReviewCoreError,
  applyCodeSections as applyCoreCodeSections,
  createReviewStore,
  repositoryName,
} from '@synergy/review-core';
import { describe, expect, it } from 'vitest';
import {
  type CreateReviewRequest,
  PreviewNotReadyError,
  applyReviewAnalysis,
  createOrResumeReview,
  formatReviewStatusJson,
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
      const item = store.readBundle(created.reference.workspaceId, created.reference.revisionId)
        .snapshot.items[0]!;
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
      const reviewItemId = createReviewStore(root).readBundle(
        created.reference.workspaceId,
        created.reference.revisionId,
      ).snapshot.items[0]?.id;
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
      const reviewItemId = createReviewStore(root).readBundle(
        created.reference.workspaceId,
        created.reference.revisionId,
      ).snapshot.items[0]?.id;
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
      const reviewItemId = createReviewStore(root).readBundle(
        created.reference.workspaceId,
        created.reference.revisionId,
      ).snapshot.items[0]?.id;
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
      const acceptedItem = createReviewStore(roots[0]!).readBundle(
        accepted.reference.workspaceId,
        accepted.reference.revisionId,
      ).snapshot.items[0]!;
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
});
