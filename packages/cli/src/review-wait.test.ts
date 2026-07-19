import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, rmSync, type watch } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyCodeSections,
  buildScopeSnapshot,
  createQuestionQueue,
  createReviewStore,
  resolveReviewItemContext,
  resolveReviewLineSelection,
} from '@synergy/review-core';
import type {
  ReviewInsights,
  ReviewProgress,
  ReviewQuestionInput,
  ReviewRef,
  ReviewSnapshot,
  ReviewWorkspace,
} from '@synergy/review-core';
import { afterEach, describe, expect, it } from 'vitest';
import { waitForReviewQuestions } from './review-wait.js';

const REFERENCE: ReviewRef = { workspaceId: 'workspace-1', revisionId: 'revision-1' };
const SOURCE = { kind: 'scope' as const, patterns: ['src'], headSha: 'abc123' };
const CREATED_AT = '2026-07-19T12:00:00.000Z';
const temporaryRoots: string[] = [];

function makeWorkspace(): ReviewWorkspace {
  return {
    schemaVersion: 1,
    id: REFERENCE.workspaceId,
    repository: { root: '/repository', name: 'repository' },
    source: SOURCE,
    currentRevisionId: REFERENCE.revisionId,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  };
}

function makeSnapshot(): ReviewSnapshot {
  return applyCodeSections(
    buildScopeSnapshot({
      revisionId: REFERENCE.revisionId,
      source: SOURCE,
      fingerprint: 'snapshot-fingerprint',
      createdAt: CREATED_AT,
      files: [
        { path: 'src/use-access.ts', binary: false, lines: [{ number: 1, text: 'export {};' }] },
      ],
    }),
    [{ path: 'src/use-access.ts', label: 'useAccess', start: 1, end: 1 }],
  );
}

function reviewItemId(snapshot: ReviewSnapshot): string {
  const reviewItemId = snapshot.items[0]?.id;
  if (!reviewItemId) throw new Error('test fixture must create one review item');
  return reviewItemId;
}

function makeInsights(itemId: string): ReviewInsights {
  return {
    schemaVersion: 1,
    revisionId: REFERENCE.revisionId,
    groups: [{ id: 'group-1', label: 'Access', reviewItemIds: [itemId] }],
    items: [
      {
        reviewItemId: itemId,
        description: 'Synchronizes access state.',
        confidence: 'high',
        evidencePaths: ['src/use-access.ts'],
      },
    ],
  };
}

function makeProgress(itemId: string): ReviewProgress {
  return {
    schemaVersion: 1,
    updatedAt: CREATED_AT,
    items: { [itemId]: { status: 'needs-review' } },
  };
}

function makeQuestion(): ReviewQuestionInput {
  const snapshot = makeSnapshot();
  const itemId = reviewItemId(snapshot);
  const itemContext = resolveReviewItemContext(snapshot, itemId);
  const selectedRow = itemContext.rows[0];
  if (!selectedRow) throw new Error('test fixture must create one selectable row');
  return {
    id: 'question-1',
    path: 'src/use-access.ts',
    reviewItemId: itemId,
    selection: resolveReviewLineSelection(snapshot, itemId, [selectedRow.id]),
    itemContext,
    description: 'Synchronizes access state.',
    body: 'Why does this hook synchronize access state?',
    createdAt: CREATED_AT,
  };
}

function createQueue() {
  const root = mkdtempSync(join(tmpdir(), 'synergy-review-wait-'));
  temporaryRoots.push(root);
  const snapshot = makeSnapshot();
  const itemId = reviewItemId(snapshot);
  createReviewStore(root).createRevision(
    makeWorkspace(),
    snapshot,
    makeInsights(itemId),
    makeProgress(itemId),
  );
  return { root, queue: createQuestionQueue(root, REFERENCE) };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('waitForReviewQuestions', () => {
  it('returns queued questions immediately', async () => {
    const { root, queue } = createQueue();
    queue.enqueue(makeQuestion());

    const result = await waitForReviewQuestions({
      root,
      reference: REFERENCE,
      listenerId: 'listener-1',
      timeoutMs: 5_000,
    });

    expect(result).toMatchObject({ status: 'questions', listenerId: 'listener-1' });
    expect(result.questions.map((question) => question.id)).toEqual(['question-1']);
  });

  it('returns failed questions immediately as retryable work', async () => {
    const { root, queue } = createQueue();
    const now = Date.now();
    const question = queue.enqueue({ ...makeQuestion(), createdAt: new Date(now).toISOString() });
    const claimed = queue.claim(question.id, 'agent-a', now, 60_000);
    const token = claimed.question?.claim?.token;
    if (!token) throw new Error('test expected an active claim token');
    expect(queue.fail(question.id, 'agent-a', token, 'Answer generation failed.', now + 1)).toBe(
      true,
    );

    const result = await waitForReviewQuestions({
      root,
      reference: REFERENCE,
      listenerId: 'listener-1',
      timeoutMs: 5_000,
    });

    expect(result.questions).toMatchObject([
      { id: 'question-1', status: 'failed', failureMessage: 'Answer generation failed.' },
    ]);
  });

  it('requeues an expired claim before deciding whether to wait', async () => {
    const { root, queue } = createQueue();
    const fakeWatcher = new EventEmitter() as ReturnType<typeof watch>;
    fakeWatcher.close = () => {};
    const now = Date.now() - 10_000;
    const question = queue.enqueue({ ...makeQuestion(), createdAt: new Date(now).toISOString() });
    expect(queue.claim(question.id, 'abandoned-listener', now, 1).ok).toBe(true);

    const result = await waitForReviewQuestions({
      root,
      reference: REFERENCE,
      listenerId: 'listener-1',
      timeoutMs: 1,
      watchImpl: (() => fakeWatcher) as typeof watch,
    });

    expect(result.questions).toMatchObject([{ id: 'question-1', status: 'queued' }]);
  });

  it('rescans on heartbeat when a claim expires after watcher attachment', async () => {
    const { root, queue } = createQueue();
    const queued = queue.enqueue(makeQuestion());
    const fakeWatcher = new EventEmitter() as ReturnType<typeof watch>;
    let watcherClosed = false;
    fakeWatcher.close = () => {
      watcherClosed = true;
    };
    let touches = 0;
    let expired = false;
    let removals = 0;

    const result = await waitForReviewQuestions({
      root,
      reference: REFERENCE,
      listenerId: 'listener-1',
      watchImpl: (() => fakeWatcher) as typeof watch,
      heartbeatMs: 100,
      timeoutMs: 150,
      scanQuestions: () => (expired ? [queued] : []),
      touchListener: () => {
        touches += 1;
        if (touches === 2) expired = true;
      },
      removeListener: () => {
        removals += 1;
      },
      beforeTimeoutScan: () => {
        expired = false;
      },
    });

    expect(result.questions.map((question) => question.id)).toEqual(['question-1']);
    expect(watcherClosed).toBe(true);
    expect(removals).toBe(1);
  });

  it('removes listener presence when its bounded wait expires', async () => {
    const { root } = createQueue();
    const fakeWatcher = new EventEmitter() as ReturnType<typeof watch>;
    fakeWatcher.close = () => {};
    const listenerPath = join(
      root,
      '.synergy',
      'reviews',
      REFERENCE.workspaceId,
      'revisions',
      REFERENCE.revisionId,
      'questions',
      '.listeners',
      'listener-1.json',
    );

    const result = await waitForReviewQuestions({
      root,
      reference: REFERENCE,
      listenerId: 'listener-1',
      timeoutMs: 30,
      watchImpl: (() => fakeWatcher) as typeof watch,
    });

    expect(result.status).toBe('timeout');
    expect(existsSync(listenerPath)).toBe(false);
  });

  it('rescans after a watcher notification without relying on timing-sensitive filesystem events', async () => {
    const { root, queue } = createQueue();
    const fakeWatcher = new EventEmitter() as ReturnType<typeof watch>;
    fakeWatcher.close = () => {};
    const watchImpl = (() => fakeWatcher) as typeof watch;
    const pending = waitForReviewQuestions({
      root,
      reference: REFERENCE,
      listenerId: 'listener-1',
      timeoutMs: 5_000,
      watchImpl,
    });

    queue.enqueue(makeQuestion());
    fakeWatcher.emit('change', 'question-1.json');

    const result = await pending;
    expect(result.questions.map((question) => question.id)).toEqual(['question-1']);
  });

  it('cleans listener presence when the caller aborts the foreground wait', async () => {
    const { root } = createQueue();
    const controller = new AbortController();
    const pending = waitForReviewQuestions({
      root,
      reference: REFERENCE,
      listenerId: 'listener-1',
      timeoutMs: 5_000,
      signal: controller.signal,
    });

    controller.abort();
    const result = await pending;

    expect(result.status).toBe('timeout');
  });

  it('does a final durable scan at the timeout boundary', async () => {
    const { root, queue } = createQueue();
    const fakeWatcher = new EventEmitter() as ReturnType<typeof watch>;
    fakeWatcher.close = () => {};

    const result = await waitForReviewQuestions({
      root,
      reference: REFERENCE,
      listenerId: 'listener-1',
      timeoutMs: 1,
      watchImpl: (() => fakeWatcher) as typeof watch,
      beforeTimeoutScan: () => queue.enqueue(makeQuestion()),
    });

    expect(result.status).toBe('questions');
    expect(result.questions.map((question) => question.id)).toEqual(['question-1']);
  });

  it('rejects and cleans up when watcher construction fails synchronously', async () => {
    const { root } = createQueue();
    const watchImpl = (() => {
      throw new Error('watch unavailable');
    }) as typeof watch;

    await expect(
      waitForReviewQuestions({
        root,
        reference: REFERENCE,
        listenerId: 'listener-1',
        timeoutMs: 5_000,
        watchImpl,
      }),
    ).rejects.toThrow('watch unavailable');
  });

  it('rejects when a heartbeat touch fails', async () => {
    const { root } = createQueue();
    const fakeWatcher = new EventEmitter() as ReturnType<typeof watch>;
    fakeWatcher.close = () => {};
    let touches = 0;

    await expect(
      waitForReviewQuestions({
        root,
        reference: REFERENCE,
        listenerId: 'listener-1',
        timeoutMs: 5_000,
        watchImpl: (() => fakeWatcher) as typeof watch,
        heartbeatMs: 1,
        touchListener: () => {
          touches += 1;
          if (touches > 1) throw new Error('presence failed');
        },
      }),
    ).rejects.toThrow('presence failed');
  });
});
