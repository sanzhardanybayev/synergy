import { mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReviewCoreError, createReviewStore, hashText, repositoryName } from '@synergy/review-core';
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
  it('uses canonical shared freshness for text and JSON readiness, failing capture closed', () => {
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
      applyReviewAnalysis({
        root,
        reference: created.reference,
        analysis: {
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

  it('accepts one validated analysis payload and rejects duplicates', () => {
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
      const result = applyReviewAnalysis({
        root,
        reference: created.reference,
        analysis,
      });
      expect(result.revisionId).toBe(created.reference.revisionId);
      expect(() =>
        applyReviewAnalysis({
          root,
          reference: created.reference,
          analysis,
        }),
      ).toThrow(/already/i);
      expect(
        printReviewStatus({ root, reference: created.reference, runner: createRunner() }),
      ).toContain('needs review');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('requires evidence from a captured file', () => {
    const root = join(tmpdir(), `synergy-review-evidence-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    try {
      const created = createOrResumeReview(createRequest(root));
      const reviewItemId = createReviewStore(root).readBundle(
        created.reference.workspaceId,
        created.reference.revisionId,
      ).snapshot.items[0]?.id;
      if (!reviewItemId) throw new Error('fixture capture must create one review item');

      expect(() =>
        applyReviewAnalysis({
          root,
          reference: created.reference,
          analysis: {
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
        }),
      ).toThrow(/captured/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
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

  it('finalizes scoped snapshots from proposed code sections exactly once', () => {
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
      expect(() =>
        applyReviewAnalysis({
          root,
          reference: created.reference,
          analysis: { groups: [], items: [] },
        }),
      ).toThrow(/requires proposed code sections/i);
      expect(
        createReviewStore(root).isAnalysisFinalized(
          created.reference.workspaceId,
          created.reference.revisionId,
        ),
      ).toBe(false);
      const section = { path: 'src/example.ts', label: 'First export', start: 1, end: 1 };
      const itemId = `code-section-${hashText(
        'src/example.ts\nFirst export\n\nexport const second = 2;\n',
      ).slice(0, 16)}`;

      applyReviewAnalysis({
        root,
        reference: created.reference,
        analysis: {
          sections: [section],
          groups: [{ id: 'exports', label: 'Exports', reviewItemIds: [itemId] }],
          items: [
            {
              reviewItemId: itemId,
              description: 'Defines the first scoped export for the module.',
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
      expect(finalized.snapshot.items).toHaveLength(1);
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
      expect(() =>
        applyReviewAnalysis({
          root,
          reference: created.reference,
          analysis: { sections: [section], groups: [], items: [] },
        }),
      ).toThrow(/already/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
