import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ProposedCodeSection,
  type RemovalRationale,
  type ReviewRef,
  type ReviewSnapshot,
  createQuestionQueue,
  createReviewStore,
  deriveReviewReadiness,
  deriveSnapshotRemovalRuns,
  resolveReviewItemContext,
} from '@synergy/review-core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type ApplyReviewAnalysisDependencies,
  applyReviewAnalysis,
  createOrResumeReview,
  refreshReview,
} from './review-actions.js';
import { waitForReviewQuestions } from './review-wait.js';

const repositories = new Set<string>();

function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}

function createRepository(): string {
  const root = mkdtempSync(join(tmpdir(), 'synergy-review-e2e-'));
  repositories.add(root);
  git(root, 'init', '--quiet');
  git(root, 'config', 'user.name', 'Synergy Test');
  git(root, 'config', 'user.email', 'synergy@example.test');
  return root;
}

function commitAll(root: string, message: string): void {
  git(root, 'add', '.');
  git(root, 'commit', '--quiet', '-m', message);
}

function reviewItemIdContaining(snapshot: ReviewSnapshot, text: string): string {
  if (snapshot.kind !== 'diff') throw new Error('expected a diff snapshot');
  const hunk = snapshot.files
    .flatMap((file) => file.hunks)
    .find((candidate) => candidate.lines.some((line) => line.text === text));
  if (!hunk?.reviewItemId) throw new Error(`missing review hunk containing ${text}`);
  return hunk.reviewItemId;
}

/** Blanket "dead-code" rationale for every derived removal run in the snapshot, sufficient to
 * satisfy the removal-coverage gate in tests that are not themselves exercising removal
 * semantics. */
function removalsForSnapshot(snapshot: ReviewSnapshot): RemovalRationale[] {
  return deriveSnapshotRemovalRuns(snapshot).map((run) => ({
    reviewItemId: run.reviewItemId,
    run: { path: run.path, start: run.start, end: run.end },
    reason: 'dead-code',
    description: 'Removed as part of this change.',
  }));
}

async function applyCompleteDiffAnalysis(root: string, reference: ReviewRef): Promise<void> {
  const bundle = createReviewStore(root).readBundle(reference.workspaceId, reference.revisionId);
  await applyReviewAnalysis({
    root,
    reference,
    analysis: {
      kind: 'diff',
      summary: 'Adjusts two staged lines in the example module.',
      groups: [
        {
          id: 'staged-changes',
          label: 'Staged changes',
          intro: 'Both hunks land in the same file.',
          reviewItemIds: bundle.snapshot.items.map((item) => item.id),
        },
      ],
      items: bundle.snapshot.items.map((item) => ({
        reviewItemId: item.id,
        description: `Reviews the staged change in ${item.path}.`,
        confidence: 'high' as const,
        evidencePaths: [item.path],
      })),
      removals: removalsForSnapshot(bundle.snapshot),
    },
  });
}

async function applyCompleteScopeAnalysis(
  root: string,
  reference: ReviewRef,
  sections: ProposedCodeSection[],
  dependencies: ApplyReviewAnalysisDependencies = {},
): Promise<void> {
  const bundle = createReviewStore(root).readBundle(reference.workspaceId, reference.revisionId);
  if (bundle.snapshot.kind !== 'scope') throw new Error('expected a scoped snapshot');
  await applyReviewAnalysis(
    {
      root,
      reference,
      analysis: {
        kind: 'scope',
        sections: sections.map((section, index) => ({
          key: `section-${index + 1}`,
          ...section,
          description: `Reviews ${section.label} in the selected scope.`,
          confidence: 'high' as const,
          evidencePaths: [section.path],
        })),
        groups: [
          {
            id: 'scoped-sections',
            label: 'Scoped sections',
            sectionKeys: sections.map((_section, index) => `section-${index + 1}`),
          },
        ],
      },
    },
    dependencies,
  );
}

async function createTwoHunkReview(): Promise<{ root: string; reference: ReviewRef }> {
  const root = createRepository();
  mkdirSync(join(root, 'src'), { recursive: true });
  const base = Array.from({ length: 30 }, (_, index) => `export const line${index + 1} = 'base';`);
  writeFileSync(join(root, 'src', 'example.ts'), `${base.join('\n')}\n`, 'utf8');
  commitAll(root, 'base');

  const changed = [...base];
  changed[2] = "export const line3 = 'staged-top';";
  changed[24] = "export const line25 = 'staged-bottom';";
  writeFileSync(join(root, 'src', 'example.ts'), `${changed.join('\n')}\n`, 'utf8');
  git(root, 'add', 'src/example.ts');

  const created = createOrResumeReview({ root, source: { kind: 'staged' } });
  await applyCompleteDiffAnalysis(root, created.reference);
  return { root, reference: created.reference };
}

afterEach(() => {
  for (const root of repositories) rmSync(root, { recursive: true, force: true });
  repositories.clear();
});

describe('integrated review workflow', () => {
  it('completes a selected-line staged review and reconciles only the changed hunk', async () => {
    const { root, reference } = await createTwoHunkReview();
    const store = createReviewStore(root);
    const initial = store.readBundle(reference.workspaceId, reference.revisionId);
    expect(initial.snapshot.items).toHaveLength(2);
    expect(initial.insights.summary).toBe('Adjusts two staged lines in the example module.');
    expect(initial.insights.groups[0]?.intro).toBe('Both hunks land in the same file.');

    for (const item of initial.snapshot.items) {
      store.patchItemProgress(reference.workspaceId, reference.revisionId, item.id, {
        status: 'reviewed',
      });
    }

    const selectedItemId = reviewItemIdContaining(
      initial.snapshot,
      "export const line3 = 'staged-top';",
    );
    const itemContext = resolveReviewItemContext(initial.snapshot, selectedItemId);
    const selectedLine = itemContext.rows.find((row) => row.kind === 'add');
    if (!selectedLine) throw new Error('expected an added line in the staged hunk');
    const queue = createQuestionQueue(root, reference);
    const question = queue.enqueue({
      id: 'question-staged-line',
      path: itemContext.item.path,
      reviewItemId: selectedItemId,
      selection: { kind: 'diff', selectedLineIds: [selectedLine.id] },
      itemContext,
      description: 'Reviews the selected staged line.',
      body: 'Why does this value change?',
      createdAt: new Date().toISOString(),
    });
    expect(
      deriveReviewReadiness(store.readBundle(reference.workspaceId, reference.revisionId)),
    ).toMatchObject({
      ready: false,
      unanswered: 1,
    });

    const now = Date.now();
    const claimed = queue.claim(question.id, 'agent-staged', now, 60_000);
    if (!claimed.ok || !claimed.question?.claim) throw new Error('expected the question claim');
    queue.answer(
      question.id,
      'agent-staged',
      claimed.question.claim.token,
      'The staged value enables the new behavior.',
      now + 1,
    );
    expect(
      deriveReviewReadiness(store.readBundle(reference.workspaceId, reference.revisionId)),
    ).toEqual({
      ready: true,
      preparing: false,
      pending: 0,
      stale: 0,
      unanswered: 0,
      sourceChanged: false,
    });

    const revised = Array.from(
      { length: 30 },
      (_, index) => `export const line${index + 1} = 'base';`,
    );
    revised[2] = "export const line3 = 'revised-top';";
    revised[24] = "export const line25 = 'staged-bottom';";
    writeFileSync(join(root, 'src', 'example.ts'), `${revised.join('\n')}\n`, 'utf8');
    git(root, 'add', 'src/example.ts');

    const refreshed = refreshReview({ root, workspaceId: reference.workspaceId });
    const next = store.readBundle(refreshed.reference.workspaceId, refreshed.reference.revisionId);
    const changedItemId = reviewItemIdContaining(
      next.snapshot,
      "export const line3 = 'revised-top';",
    );
    const unchangedItemId = reviewItemIdContaining(
      next.snapshot,
      "export const line25 = 'staged-bottom';",
    );
    expect(next.progress.items[unchangedItemId]).toMatchObject({ status: 'carried-forward' });
    expect(next.progress.items[changedItemId]).toEqual({ status: 'needs-review' });
    expect(deriveReviewReadiness(next).ready).toBe(false);
  });

  it('keeps ignored dependency and build output outside a scoped review', async () => {
    const root = createRepository();
    const sourcePath = 'features/subscriptions/useSubscription.ts';
    const screenPath = 'features/subscriptions/screens/Paywall.tsx';
    mkdirSync(join(root, 'features', 'subscriptions', 'screens'), { recursive: true });
    writeFileSync(
      join(root, sourcePath),
      'export function useSubscription() {\n  return { active: true };\n}\n',
      'utf8',
    );
    writeFileSync(join(root, screenPath), "export const Paywall = 'paywall';\n", 'utf8');
    writeFileSync(
      join(root, '.gitignore'),
      'node_modules/\nfeatures/subscriptions/build/\n',
      'utf8',
    );
    commitAll(root, 'subscription sources');
    mkdirSync(join(root, 'node_modules', 'ignored-package'), { recursive: true });
    mkdirSync(join(root, 'features', 'subscriptions', 'build'), { recursive: true });
    writeFileSync(join(root, 'node_modules', 'ignored-package', 'index.js'), 'ignored\n', 'utf8');
    writeFileSync(
      join(root, 'features', 'subscriptions', 'build', 'generated.js'),
      'ignored\n',
      'utf8',
    );

    const created = createOrResumeReview({
      root,
      source: { kind: 'scope', patterns: ['features/subscriptions'] },
    });
    const store = createReviewStore(root);
    const captured = store.readBundle(created.reference.workspaceId, created.reference.revisionId);
    expect(captured.snapshot.files.map((file) => file.path)).toEqual([screenPath, sourcePath]);

    if (captured.snapshot.kind !== 'scope') throw new Error('expected a scoped snapshot');
    const sections = [
      { path: sourcePath, label: 'useSubscription', start: 1, end: 4 },
      { path: screenPath, label: 'Paywall', start: 1, end: 2 },
    ];
    await applyReviewAnalysis({
      root,
      reference: created.reference,
      analysis: {
        kind: 'scope',
        sections: sections.map((section, index) => ({
          key: `subscription-${index + 1}`,
          ...section,
          description: `Reviews ${section.label} in the subscription scope.`,
          confidence: 'high' as const,
          evidencePaths: [section.path],
        })),
        groups: [
          {
            id: 'subscriptions',
            label: 'Subscription access',
            sectionKeys: sections.map((_section, index) => `subscription-${index + 1}`),
          },
        ],
      },
    });

    const finalized = store.readBundle(created.reference.workspaceId, created.reference.revisionId);
    expect(finalized.snapshot.files.map((file) => file.path)).toEqual([screenPath, sourcePath]);
    expect(finalized.snapshot.items.map((item) => item.path)).toEqual([sourcePath, screenPath]);
    expect(finalized.snapshot.files.some((file) => file.path.includes('node_modules'))).toBe(false);
    expect(finalized.snapshot.files.some((file) => file.path.includes('/build/'))).toBe(false);
  });

  it('reconciles finalized scoped sections against their explicit predecessor revision', async () => {
    const root = createRepository();
    const changedPath = 'features/subscriptions/useSubscription.ts';
    const unchangedPath = 'features/subscriptions/formatPlan.ts';
    mkdirSync(join(root, 'features', 'subscriptions'), { recursive: true });
    writeFileSync(
      join(root, changedPath),
      [
        'export function useSubscription() {',
        '  return { active: true };',
        '}',
        'export const subscriptionVersion = 1;',
        '',
      ].join('\n'),
      'utf8',
    );
    writeFileSync(
      join(root, unchangedPath),
      [
        'export function formatPlan() {',
        "  return 'monthly';",
        '}',
        "export const planLabel = 'Plan';",
        '',
      ].join('\n'),
      'utf8',
    );
    commitAll(root, 'subscription scope');
    const sections = [
      { path: changedPath, label: 'useSubscription', start: 1, end: 5 },
      { path: unchangedPath, label: 'formatPlan', start: 1, end: 5 },
    ];
    const created = createOrResumeReview({
      root,
      source: { kind: 'scope', patterns: ['features/subscriptions'] },
    });
    await applyCompleteScopeAnalysis(root, created.reference, sections);
    const store = createReviewStore(root);
    const previous = store.readBundle(created.reference.workspaceId, created.reference.revisionId);
    for (const item of previous.snapshot.items) {
      store.patchItemProgress(
        created.reference.workspaceId,
        created.reference.revisionId,
        item.id,
        {
          status: 'reviewed',
        },
      );
    }
    const previousChangedItem = previous.snapshot.items.find((item) => item.path === changedPath);
    if (!previousChangedItem) throw new Error('missing changed predecessor section');

    writeFileSync(
      join(root, changedPath),
      [
        'export function useSubscription() {',
        '  return { active: false };',
        '}',
        'export const subscriptionVersion = 1;',
        '',
      ].join('\n'),
      'utf8',
    );
    const refreshed = refreshReview({ root, workspaceId: created.reference.workspaceId });
    let predecessorReads = 0;
    const trackingStore = {
      ...store,
      readBundle(workspaceId: string, revisionId: string) {
        if (revisionId === created.reference.revisionId) predecessorReads += 1;
        return store.readBundle(workspaceId, revisionId);
      },
    };
    await expect(
      applyCompleteScopeAnalysis(root, refreshed.reference, sections, {
        createStore: () => trackingStore,
        applyCodeSections: (snapshot) => snapshot,
      }),
    ).rejects.toThrow(/one review item per section/i);
    expect(predecessorReads).toBe(0);
    expect(
      store.isAnalysisFinalized(refreshed.reference.workspaceId, refreshed.reference.revisionId),
    ).toBe(false);
    expect(
      store.readBundle(refreshed.reference.workspaceId, refreshed.reference.revisionId).snapshot
        .items,
    ).toEqual([]);

    await applyCompleteScopeAnalysis(root, refreshed.reference, sections, {
      createStore: () => trackingStore,
    });
    expect(predecessorReads).toBe(1);
    const current = store.readBundle(
      refreshed.reference.workspaceId,
      refreshed.reference.revisionId,
    );
    const changedItem = current.snapshot.items.find((item) => item.path === changedPath);
    const unchangedItem = current.snapshot.items.find((item) => item.path === unchangedPath);
    if (!changedItem || !unchangedItem) throw new Error('missing refreshed scope sections');

    expect(changedItem.id).toBe(previousChangedItem.id);
    expect(current.snapshot.predecessorRevisionId).toBe(created.reference.revisionId);
    expect(current.progress.items[changedItem.id]).toEqual({ status: 'needs-review' });
    expect(current.progress.items[unchangedItem.id]).toMatchObject({
      status: 'carried-forward',
      inheritedFrom: { revisionId: created.reference.revisionId },
    });
    expect(
      store.readBundle(created.reference.workspaceId, created.reference.revisionId).progress.items,
    ).toEqual(
      Object.fromEntries(
        previous.snapshot.items.map((item) => [
          item.id,
          expect.objectContaining({ status: 'reviewed' }),
        ]),
      ),
    );
  });

  it('lets a fresh waiter claim and answer a question after the first listener is disposed', async () => {
    const { root, reference } = await createTwoHunkReview();
    const store = createReviewStore(root);
    const bundle = store.readBundle(reference.workspaceId, reference.revisionId);
    const item = bundle.snapshot.items[0];
    if (!item) throw new Error('expected a review item');
    const itemContext = resolveReviewItemContext(bundle.snapshot, item.id);
    const selectedLine = itemContext.rows[0];
    if (!selectedLine) throw new Error('expected a selectable review line');

    const firstController = new AbortController();
    const firstWait = waitForReviewQuestions({
      root,
      reference,
      listenerId: 'agent-first',
      signal: firstController.signal,
      timeoutMs: 2_000,
    });
    const queue = createQuestionQueue(root, reference);
    const question = queue.enqueue({
      id: 'question-reconnect',
      path: item.path,
      reviewItemId: item.id,
      selection: { kind: 'diff', selectedLineIds: [selectedLine.id] },
      itemContext,
      description: 'Reviews reconnect durability.',
      body: 'Can a fresh listener answer this?',
      createdAt: new Date().toISOString(),
    });
    firstController.abort();
    await expect(firstWait).resolves.toMatchObject({ status: 'timeout', questions: [] });

    const secondWait = await waitForReviewQuestions({
      root,
      reference,
      listenerId: 'agent-second',
      timeoutMs: 2_000,
    });
    expect(secondWait.questions.map((candidate) => candidate.id)).toContain(question.id);
    const now = Date.now();
    const claim = queue.claim(question.id, secondWait.listenerId, now, 60_000);
    if (!claim.ok || !claim.question?.claim) throw new Error('fresh listener did not claim');
    const answer = queue.answer(
      question.id,
      secondWait.listenerId,
      claim.question.claim.token,
      'Yes. The question survived the first listener.',
      now + 1,
    );
    expect(store.readBundle(reference.workspaceId, reference.revisionId)).toMatchObject({
      questions: [{ id: question.id, status: 'answered' }],
      answers: [{ id: answer.id, listenerId: 'agent-second' }],
    });
  });

  it('carries stored excludes through a refresh so excluded files never flood back in', () => {
    const root = createRepository();
    mkdirSync(join(root, '.vouch'), { recursive: true });
    writeFileSync(join(root, '.vouch', 'artifact.json'), '{"a":1}\n', 'utf8');
    writeFileSync(join(root, 'src.ts'), 'export const value = 1;\n', 'utf8');
    commitAll(root, 'base');

    writeFileSync(join(root, '.vouch', 'artifact.json'), '{"a":2}\n', 'utf8');
    writeFileSync(join(root, 'src.ts'), 'export const value = 2;\n', 'utf8');
    git(root, 'add', '.');

    const created = createOrResumeReview({
      root,
      source: { kind: 'staged', excludes: ['.vouch'] },
    });
    const store = createReviewStore(root);
    const firstBundle = store.readBundle(
      created.reference.workspaceId,
      created.reference.revisionId,
    );
    if (firstBundle.snapshot.kind !== 'diff') throw new Error('expected a diff snapshot');
    expect(firstBundle.snapshot.files.map((file) => file.path)).toEqual(['src.ts']);
    expect(firstBundle.snapshot.source.excludes).toEqual(['.vouch']);

    // A further staged change to both the tracked file and the excluded directory: without
    // excludes surviving the refresh, `.vouch/artifact.json` would flood back into the review.
    writeFileSync(join(root, 'src.ts'), 'export const value = 3;\n', 'utf8');
    writeFileSync(join(root, '.vouch', 'artifact.json'), '{"a":3}\n', 'utf8');
    git(root, 'add', 'src.ts', '.vouch/artifact.json');

    const refreshed = refreshReview({ root, workspaceId: created.reference.workspaceId });
    expect(refreshed.reference.workspaceId).toBe(created.reference.workspaceId);
    expect(refreshed.reference.revisionId).not.toBe(created.reference.revisionId);
    expect(refreshed.excludes).toEqual(['.vouch']);

    const refreshedBundle = store.readBundle(
      refreshed.reference.workspaceId,
      refreshed.reference.revisionId,
    );
    if (refreshedBundle.snapshot.kind !== 'diff') throw new Error('expected a diff snapshot');
    expect(refreshedBundle.snapshot.files.map((file) => file.path)).toEqual(['src.ts']);
    expect(refreshedBundle.snapshot.source.excludes).toEqual(['.vouch']);
  });

  it('resumes the same identity for reordered excludes and captures a fresh one for a different set', () => {
    const root = createRepository();
    mkdirSync(join(root, '.vouch'), { recursive: true });
    mkdirSync(join(root, '.lavish'), { recursive: true });
    writeFileSync(join(root, '.vouch', 'a.json'), '{}\n', 'utf8');
    writeFileSync(join(root, '.lavish', 'b.json'), '{}\n', 'utf8');
    writeFileSync(join(root, 'src.ts'), 'export const value = 1;\n', 'utf8');
    commitAll(root, 'base');
    writeFileSync(join(root, 'src.ts'), 'export const value = 2;\n', 'utf8');
    git(root, 'add', 'src.ts');

    const first = createOrResumeReview({
      root,
      source: { kind: 'staged', excludes: ['.vouch', '.lavish'] },
    });
    const reordered = createOrResumeReview({
      root,
      source: { kind: 'staged', excludes: ['.lavish', '.vouch'] },
    });
    expect(reordered.resumed).toBe(true);
    expect(reordered.reference.workspaceId).toBe(first.reference.workspaceId);
    expect(reordered.reference.revisionId).toBe(first.reference.revisionId);

    const differentSet = createOrResumeReview({
      root,
      source: { kind: 'staged', excludes: ['.vouch'] },
    });
    expect(differentSet.resumed).toBe(false);
    expect(differentSet.reference.revisionId).not.toBe(first.reference.revisionId);
  });
});
