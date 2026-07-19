import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { hashText } from '../src/hash.js';
import { SAFE_SEGMENT } from '../src/ids.js';
import {
  type QuestionPersistenceOptions,
  type QuestionPublication,
  createQuestionQueue,
  reconcileExpiredQuestions,
} from '../src/questions.js';
import { resolveReviewItemContext, resolveReviewLineSelection } from '../src/review-lines.js';
import { applyCodeSections, buildScopeSnapshot } from '../src/scope.js';
import { createReviewStore } from '../src/store.js';
import type {
  ReviewInsights,
  ReviewProgress,
  ReviewQuestion,
  ReviewQuestionGeneration,
  ReviewRef,
  ReviewSnapshot,
  ReviewWorkspace,
} from '../src/types.js';

const REFERENCE: ReviewRef = { workspaceId: 'workspace-1', revisionId: 'revision-1' };
const NOW = Date.parse('2026-07-19T12:00:00.000Z');
const BODY = 'The hook synchronizes access state.';
const temporaryRoots: string[] = [];

function makeWorkspace(reference = REFERENCE): ReviewWorkspace {
  return {
    schemaVersion: 1,
    id: reference.workspaceId,
    repository: { root: '/repository', name: 'repository' },
    source: { kind: 'staged', headSha: 'abc123' },
    currentRevisionId: reference.revisionId,
    createdAt: '2026-07-19T12:00:00.000Z',
    updatedAt: '2026-07-19T12:00:00.000Z',
  };
}

function makeSnapshot(reference = REFERENCE): ReviewSnapshot {
  return {
    schemaVersion: 1,
    kind: 'scope',
    revisionId: reference.revisionId,
    source: { kind: 'staged', headSha: 'abc123' },
    fingerprint: 'snapshot-fingerprint',
    createdAt: '2026-07-19T12:00:00.000Z',
    files: [
      { path: 'src/use-access.ts', binary: false, lines: [{ number: 1, text: 'export {};' }] },
    ],
    items: [
      {
        id: 'item-1',
        kind: 'code-section',
        path: 'src/use-access.ts',
        label: 'useAccess',
        range: { start: 1, end: 1 },
        contentHash: hashText('export {};'),
        locationHash: 'location-hash',
      },
    ],
  };
}

function makeInsights(reference = REFERENCE): ReviewInsights {
  return {
    schemaVersion: 1,
    revisionId: reference.revisionId,
    groups: [{ id: 'group-1', label: 'Access', reviewItemIds: ['item-1'] }],
    items: [
      {
        reviewItemId: 'item-1',
        description: 'Synchronizes access state.',
        confidence: 'high',
        evidencePaths: ['src/use-access.ts'],
      },
    ],
  };
}

function makeProgress(): ReviewProgress {
  return {
    schemaVersion: 1,
    updatedAt: '2026-07-19T12:00:00.000Z',
    items: { 'item-1': { status: 'needs-review' } },
  };
}

function makeQuestion(): Omit<
  ReviewQuestion,
  'schemaVersion' | 'workspaceId' | 'revisionId' | 'status' | 'claim'
> {
  const snapshot = makeSnapshot();
  const itemContext = resolveReviewItemContext(snapshot, 'item-1');
  return {
    id: 'question-1',
    path: 'src/use-access.ts',
    reviewItemId: 'item-1',
    selection: resolveReviewLineSelection(snapshot, 'item-1', [itemContext.rows[0]!.id]),
    itemContext,
    description: 'Synchronizes access state.',
    body: 'Why does this hook synchronize access state?',
    createdAt: '2026-07-19T12:00:00.000Z',
  };
}

function createQueueWithRoot(options: QuestionPersistenceOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), 'synergy-review-questions-'));
  temporaryRoots.push(root);
  createReviewStore(root).createRevision(
    makeWorkspace(),
    makeSnapshot(),
    makeInsights(),
    makeProgress(),
  );
  return { root, queue: createQuestionQueue(root, REFERENCE, options) };
}

function questionDirectory(root: string): string {
  return join(
    root,
    '.synergy',
    'reviews',
    REFERENCE.workspaceId,
    'revisions',
    REFERENCE.revisionId,
    'questions',
  );
}

function generationsDirectory(root: string): string {
  return join(questionDirectory(root), 'question-1.generations');
}

function generationFiles(root: string): string[] {
  return readdirSync(generationsDirectory(root))
    .filter((name) => /^\d{12}\.json$/.test(name))
    .sort();
}

function answerPath(root: string, token: string): string {
  return join(
    root,
    '.synergy',
    'reviews',
    REFERENCE.workspaceId,
    'revisions',
    REFERENCE.revisionId,
    'answers',
    `answer-question-1-${token}.json`,
  );
}

function claimToken(question: ReviewQuestion | undefined): string {
  const token = question?.claim?.token;
  if (!token) throw new Error('test expected an active claim token');
  return token;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('append-only review question generations', () => {
  it('rejects symlinked question and answer ancestors and final artifacts', () => {
    const { root, queue } = createQueueWithRoot();
    const outside = mkdtempSync(join(tmpdir(), 'synergy-review-questions-outside-'));
    temporaryRoots.push(outside);
    const questions = questionDirectory(root);
    rmSync(questions, { recursive: true, force: true });
    symlinkSync(outside, questions);

    expect(() => queue.enqueue(makeQuestion())).toThrow(/symbolic link/i);

    unlinkSync(questions);
    mkdirSync(questions, { recursive: true });
    const question = queue.enqueue(makeQuestion());
    const questionPath = join(questions, 'question-1.json');
    const questionBytes = readFileSync(questionPath, 'utf8');
    unlinkSync(questionPath);
    const outsideQuestion = join(outside, 'question.json');
    writeFileSync(outsideQuestion, questionBytes);
    symlinkSync(outsideQuestion, questionPath);
    expect(() => queue.readQuestion(question.id)).toThrow(/symbolic link/i);

    unlinkSync(questionPath);
    writeFileSync(questionPath, questionBytes);
    const claimed = queue.claim(question.id, 'agent-a', NOW, 60_000);
    const token = claimToken(claimed.question);
    const answers = join(
      root,
      '.synergy',
      'reviews',
      REFERENCE.workspaceId,
      'revisions',
      REFERENCE.revisionId,
      'answers',
    );
    rmSync(answers, { recursive: true, force: true });
    symlinkSync(outside, answers);
    expect(() => queue.answer(question.id, 'agent-a', token, BODY, NOW + 1)).toThrow(
      /symbolic link/i,
    );
  });

  it('keeps the canonical question immutable while claim, renew, and release append generations', () => {
    const { root, queue } = createQueueWithRoot();
    const question = queue.enqueue(makeQuestion());
    const envelopePath = join(questionDirectory(root), 'question-1.json');
    const envelope = readFileSync(envelopePath, 'utf8');

    const claimed = queue.claim(question.id, 'agent-a', NOW, 60_000);
    const token = claimToken(claimed.question);
    expect(queue.renew(question.id, 'agent-a', token, NOW + 1, 60_000).ok).toBe(true);
    expect(queue.release(question.id, 'agent-a', token, NOW + 2)).toBe(true);

    expect(readFileSync(envelopePath, 'utf8')).toBe(envelope);
    expect(JSON.parse(envelope)).not.toHaveProperty('status');
    expect(generationFiles(root)).toEqual([
      '000000000000.json',
      '000000000001.json',
      '000000000002.json',
      '000000000003.json',
    ]);
    expect(queue.readQuestion(question.id)?.status).toBe('queued');
    expect(existsSync(join(questionDirectory(root), 'question-1.claim'))).toBe(false);
    expect(existsSync(join(questionDirectory(root), 'question-1.lock'))).toBe(false);
  });

  it('lets only one writer publish the same next generation', () => {
    const { root, queue: contender } = createQueueWithRoot();
    contender.enqueue(makeQuestion());
    let competed = false;
    const queue = createQuestionQueue(root, REFERENCE, {
      beforePublish: (publication) => {
        if (!competed && publication.kind === 'generation' && publication.state === 'claimed') {
          competed = true;
          expect(contender.claim('question-1', 'agent-b', NOW, 60_000).ok).toBe(true);
        }
      },
    });

    expect(queue.claim('question-1', 'agent-a', NOW, 60_000).ok).toBe(false);
    expect(queue.readQuestion('question-1')?.claim?.listenerId).toBe('agent-b');
    expect(generationFiles(root)).toEqual(['000000000000.json', '000000000001.json']);
  });

  it('fences a suspended owner after an expired claim is replaced', () => {
    const { root, queue } = createQueueWithRoot();
    queue.enqueue(makeQuestion());
    const original = queue.claim('question-1', 'agent-a', NOW, 60_000);
    const originalToken = claimToken(original.question);
    let replaced = false;
    const suspended = createQuestionQueue(root, REFERENCE, {
      beforePublish: (publication) => {
        if (
          !replaced &&
          publication.kind === 'generation' &&
          publication.state === 'answer-pending'
        ) {
          replaced = true;
          expect(queue.claim('question-1', 'agent-b', NOW + 60_001, 60_000).ok).toBe(true);
        }
      },
    });

    expect(() => suspended.answer('question-1', 'agent-a', originalToken, BODY, NOW + 1)).toThrow(
      /not owned/i,
    );
    expect(queue.readQuestion('question-1')?.claim?.listenerId).toBe('agent-b');
    expect(existsSync(answerPath(root, originalToken))).toBe(false);
  });

  it('serializes renew, release, and answer competition through the next generation slot', () => {
    const { root, queue } = createQueueWithRoot();
    queue.enqueue(makeQuestion());
    const claimed = queue.claim('question-1', 'agent-a', NOW, 60_000);
    const token = claimToken(claimed.question);
    let released = false;
    const renewingQueue = createQuestionQueue(root, REFERENCE, {
      beforePublish: (publication) => {
        if (!released && publication.kind === 'generation' && publication.state === 'claimed') {
          released = true;
          expect(queue.release('question-1', 'agent-a', token, NOW + 1)).toBe(true);
        }
      },
    });

    expect(renewingQueue.renew('question-1', 'agent-a', token, NOW + 1, 60_000).ok).toBe(false);
    expect(() => queue.answer('question-1', 'agent-a', token, BODY, NOW + 2)).toThrow(/not owned/i);
    expect(queue.readQuestion('question-1')?.status).toBe('queued');
  });

  it('accepts a failed processing generation and reclaims it as retryable work', () => {
    const { root, queue } = createQueueWithRoot();
    queue.enqueue(makeQuestion());
    const claimed = queue.claim('question-1', 'agent-a', NOW, 60_000);
    expect(
      queue.fail(
        'question-1',
        'agent-a',
        claimToken(claimed.question),
        'Answer generation failed.',
        NOW + 1,
      ),
    ).toBe(true);

    expect(queue.list()).toMatchObject([
      { id: 'question-1', status: 'failed', failureMessage: 'Answer generation failed.' },
    ]);
    expect(reconcileExpiredQuestions(root, REFERENCE, NOW + 2)).toMatchObject([
      { id: 'question-1', status: 'failed', failureMessage: 'Answer generation failed.' },
    ]);
    expect(queue.claim('question-1', 'agent-b', NOW + 2, 60_000)).toMatchObject({
      ok: true,
      question: { status: 'processing', claim: { listenerId: 'agent-b' } },
    });
    expect(queue.readQuestion('question-1')).not.toHaveProperty('failureMessage');
    expect(generationFiles(root)).toHaveLength(4);
  });
});

describe('answer-pending recovery', () => {
  it('records an active pending answer failure and keeps it reclaimable', () => {
    let crashed = false;
    const { root, queue } = createQueueWithRoot({
      afterPublish: (publication) => {
        if (
          !crashed &&
          publication.kind === 'generation' &&
          publication.state === 'answer-pending'
        ) {
          crashed = true;
          throw new Error('crash after pending');
        }
      },
    });
    queue.enqueue(makeQuestion());
    const claimed = queue.claim('question-1', 'agent-a', NOW, 60_000);
    const token = claimToken(claimed.question);
    expect(() => queue.answer('question-1', 'agent-a', token, BODY, NOW + 1)).toThrow(
      'crash after pending',
    );

    const recovered = createQuestionQueue(root, REFERENCE);
    expect(
      recovered.fail('question-1', 'agent-a', token, 'Model generation failed.', NOW + 2),
    ).toBe(true);
    expect(recovered.readQuestion('question-1')).toMatchObject({
      status: 'failed',
      failureMessage: 'Model generation failed.',
    });
    expect(recovered.claim('question-1', 'agent-b', NOW + 3, 60_000).ok).toBe(true);
  });

  it('requeues an expired pending generation when no answer was published', () => {
    let crashed = false;
    const { root, queue } = createQueueWithRoot({
      afterPublish: (publication) => {
        if (
          !crashed &&
          publication.kind === 'generation' &&
          publication.state === 'answer-pending'
        ) {
          crashed = true;
          throw new Error('crash after pending');
        }
      },
    });
    queue.enqueue(makeQuestion());
    const claimed = queue.claim('question-1', 'agent-a', NOW, 60_000);

    expect(() =>
      queue.answer('question-1', 'agent-a', claimToken(claimed.question), BODY, NOW + 1),
    ).toThrow('crash after pending');
    expect(queue.readQuestion('question-1')?.status).toBe('processing');
    expect(existsSync(answerPath(root, claimToken(claimed.question)))).toBe(false);

    const replacement = createQuestionQueue(root, REFERENCE).claim(
      'question-1',
      'agent-b',
      NOW + 60_001,
      60_000,
    );
    expect(replacement.ok).toBe(true);
    expect(replacement.question?.claim?.listenerId).toBe('agent-b');
  });

  it('system-finalizes an expired pending generation when the exact answer exists', () => {
    let crashed = false;
    const { root, queue } = createQueueWithRoot({
      afterPublish: (publication) => {
        if (!crashed && publication.kind === 'answer') {
          crashed = true;
          throw new Error('crash after answer');
        }
      },
    });
    queue.enqueue(makeQuestion());
    const claimed = queue.claim('question-1', 'agent-a', NOW, 60_000);
    const token = claimToken(claimed.question);

    expect(() => queue.answer('question-1', 'agent-a', token, BODY, NOW + 1)).toThrow(
      'crash after answer',
    );
    expect(existsSync(answerPath(root, token))).toBe(true);

    const recovered = createQuestionQueue(root, REFERENCE);
    expect(recovered.claim('question-1', 'agent-b', NOW + 60_001, 60_000).ok).toBe(false);
    expect(recovered.readQuestion('question-1')?.status).toBe('answered');
    expect(recovered.readAnswer(`answer-question-1-${token}`)?.body).toBe(BODY);
  });

  it('rejects a mismatched orphan answer without allowing replacement content', () => {
    let crashed = false;
    const { root, queue } = createQueueWithRoot({
      afterPublish: (publication) => {
        if (
          !crashed &&
          publication.kind === 'generation' &&
          publication.state === 'answer-pending'
        ) {
          crashed = true;
          throw new Error('crash after pending');
        }
      },
    });
    queue.enqueue(makeQuestion());
    const claimed = queue.claim('question-1', 'agent-a', NOW, 60_000);
    const token = claimToken(claimed.question);
    expect(() => queue.answer('question-1', 'agent-a', token, BODY, NOW + 1)).toThrow(
      'crash after pending',
    );
    writeFileSync(
      answerPath(root, token),
      `${JSON.stringify({
        schemaVersion: 1,
        id: `answer-question-1-${token}`,
        questionId: 'question-1',
        workspaceId: REFERENCE.workspaceId,
        revisionId: REFERENCE.revisionId,
        listenerId: 'agent-a',
        body: 'Substituted content.',
        createdAt: new Date(NOW + 1).toISOString(),
      })}\n`,
    );

    const recovered = createQuestionQueue(root, REFERENCE);
    expect(() => recovered.claim('question-1', 'agent-b', NOW + 60_001, 60_000)).toThrow(
      /does not match pending/i,
    );
    expect(() =>
      recovered.answer('question-1', 'agent-b', 'new-token', 'Replacement', NOW + 60_002),
    ).toThrow(/not owned/i);
  });

  it('does not publish answer bytes when release wins against answer-pending', () => {
    const { root, queue } = createQueueWithRoot();
    queue.enqueue(makeQuestion());
    const claimed = queue.claim('question-1', 'agent-a', NOW, 60_000);
    const token = claimToken(claimed.question);
    let released = false;
    const answeringQueue = createQuestionQueue(root, REFERENCE, {
      beforePublish: (publication) => {
        if (
          !released &&
          publication.kind === 'generation' &&
          publication.state === 'answer-pending'
        ) {
          released = true;
          expect(queue.release('question-1', 'agent-a', token, NOW + 1)).toBe(true);
        }
      },
    });

    expect(() => answeringQueue.answer('question-1', 'agent-a', token, BODY, NOW + 1)).toThrow(
      /not owned/i,
    );
    expect(existsSync(answerPath(root, token))).toBe(false);
    expect(queue.readQuestion('question-1')?.status).toBe('queued');
  });

  it('does not allow ordinary release after answer-pending is authoritative', () => {
    let suspended = false;
    const { root, queue } = createQueueWithRoot({
      afterPublish: (publication) => {
        if (
          !suspended &&
          publication.kind === 'generation' &&
          publication.state === 'answer-pending'
        ) {
          suspended = true;
          throw new Error('suspended after pending');
        }
      },
    });
    queue.enqueue(makeQuestion());
    const claimed = queue.claim('question-1', 'agent-a', NOW, 60_000);
    const token = claimToken(claimed.question);
    expect(() => queue.answer('question-1', 'agent-a', token, BODY, NOW + 1)).toThrow(
      'suspended after pending',
    );

    expect(
      createQuestionQueue(root, REFERENCE).release('question-1', 'agent-a', token, NOW + 2),
    ).toBe(false);
    expect(queue.readQuestion('question-1')?.status).toBe('processing');
  });

  it('fences answer publication when expiry queues between authorization and link', () => {
    const { root, queue } = createQueueWithRoot();
    queue.enqueue(makeQuestion());
    const claimed = queue.claim('question-1', 'agent-a', NOW, 60_000);
    const token = claimToken(claimed.question);
    let expired = false;
    const answeringQueue = createQuestionQueue(root, REFERENCE, {
      link: (temporary, destination, publication) => {
        if (!expired && publication.kind === 'answer') {
          expired = true;
          reconcileExpiredQuestions(root, REFERENCE, NOW + 60_001);
        }
        linkSync(temporary, destination);
      },
    });

    expect(() => answeringQueue.answer('question-1', 'agent-a', token, BODY, NOW + 1)).toThrow(
      /lost authorization|contention/i,
    );
    expect(existsSync(answerPath(root, token))).toBe(true);
    expect(queue.readQuestion('question-1')?.status).toBe('queued');
    expect(
      createReviewStore(root).readBundle(REFERENCE.workspaceId, REFERENCE.revisionId),
    ).toMatchObject({
      questions: [{ id: 'question-1', status: 'queued' }],
      answers: [],
    });

    const replacement = queue.claim('question-1', 'agent-b', NOW + 60_002, 60_000);
    const replacementToken = claimToken(replacement.question);
    expect(
      queue.answer('question-1', 'agent-b', replacementToken, 'Replacement answer.', NOW + 60_003)
        .body,
    ).toBe('Replacement answer.');
  });
});

describe('recoverable enqueue', () => {
  it('hides generation-zero-only state and completes an exact retry', () => {
    let crashed = false;
    const { root, queue } = createQueueWithRoot({
      afterPublish: (publication) => {
        if (!crashed && publication.kind === 'generation' && publication.generation === 0) {
          crashed = true;
          throw new Error('crash after generation zero');
        }
      },
    });

    expect(() => queue.enqueue(makeQuestion())).toThrow('crash after generation zero');
    expect(existsSync(join(questionDirectory(root), 'question-1.json'))).toBe(false);
    expect(createQuestionQueue(root, REFERENCE).list()).toEqual([]);
    expect(createQuestionQueue(root, REFERENCE).enqueue(makeQuestion()).status).toBe('queued');
  });

  it('recognizes an envelope committed before an ambiguous completion error', () => {
    let crashed = false;
    const { root, queue } = createQueueWithRoot({
      afterPublish: (publication) => {
        if (!crashed && publication.kind === 'question') {
          crashed = true;
          throw new Error('crash after envelope');
        }
      },
    });

    expect(() => queue.enqueue(makeQuestion())).toThrow('crash after envelope');
    expect(createQuestionQueue(root, REFERENCE).enqueue(makeQuestion()).status).toBe('queued');
    expect(createQuestionQueue(root, REFERENCE).list()).toHaveLength(1);
  });

  it('rejects conflicting content after generation zero committed', () => {
    let crashed = false;
    const { root, queue } = createQueueWithRoot({
      afterPublish: (publication) => {
        if (!crashed && publication.kind === 'generation' && publication.generation === 0) {
          crashed = true;
          throw new Error('crash after generation zero');
        }
      },
    });
    expect(() => queue.enqueue(makeQuestion())).toThrow('crash after generation zero');

    expect(() =>
      createQuestionQueue(root, REFERENCE).enqueue({
        ...makeQuestion(),
        body: 'Conflicting question content?',
      }),
    ).toThrow(/conflict|does not match/i);
  });
});

describe('question trust boundaries', () => {
  it('uses the authoritative finalized scoped snapshot for enqueue and list validation', () => {
    const root = mkdtempSync(join(tmpdir(), 'synergy-review-finalized-scope-'));
    temporaryRoots.push(root);
    const source = { kind: 'scope' as const, patterns: ['src'], headSha: 'abc123' };
    const pending = buildScopeSnapshot({
      revisionId: REFERENCE.revisionId,
      source,
      fingerprint: 'scope-fingerprint',
      createdAt: new Date(NOW).toISOString(),
      files: [
        { path: 'src/use-access.ts', binary: false, lines: [{ number: 1, text: 'export {};' }] },
      ],
    });
    const finalized = applyCodeSections(pending, [
      { path: 'src/use-access.ts', label: 'useAccess', start: 1, end: 1 },
    ]);
    const item = finalized.items[0];
    if (!item) throw new Error('expected a finalized code section');
    const workspace: ReviewWorkspace = {
      ...makeWorkspace(),
      source,
    };
    const insights: ReviewInsights = {
      schemaVersion: 1,
      revisionId: REFERENCE.revisionId,
      groups: [{ id: 'group-1', label: 'Access', reviewItemIds: [item.id] }],
      items: [
        {
          reviewItemId: item.id,
          description: 'Synchronizes access state.',
          confidence: 'high',
          evidencePaths: ['src/use-access.ts'],
        },
      ],
    };
    const progress: ReviewProgress = {
      schemaVersion: 1,
      updatedAt: new Date(NOW).toISOString(),
      items: { [item.id]: { status: 'needs-review' } },
    };
    const store = createReviewStore(root);
    store.createRevision(
      workspace,
      pending,
      { ...insights, groups: [], items: [] },
      {
        ...progress,
        items: {},
      },
    );
    store.finalizeScopeAnalysis(
      REFERENCE.workspaceId,
      REFERENCE.revisionId,
      finalized,
      insights,
      progress,
    );
    const queue = createQuestionQueue(root, REFERENCE);
    const itemContext = resolveReviewItemContext(finalized, item.id);

    const question = queue.enqueue({
      ...makeQuestion(),
      reviewItemId: item.id,
      selection: resolveReviewLineSelection(finalized, item.id, [itemContext.rows[0]!.id]),
      itemContext,
    });
    expect(question.reviewItemId).toBe(item.id);
    expect(queue.list()).toHaveLength(1);
  });

  it('rejects a persisted envelope whose path no longer matches its review item', () => {
    const { root, queue } = createQueueWithRoot();
    queue.enqueue(makeQuestion());
    const envelopePath = join(questionDirectory(root), 'question-1.json');
    const envelope = JSON.parse(readFileSync(envelopePath, 'utf8')) as Record<string, unknown>;
    writeFileSync(envelopePath, `${JSON.stringify({ ...envelope, path: 'src/other.ts' })}\n`);

    expect(() => queue.list()).toThrow(/path does not match/i);
    expect(() => queue.readQuestion('question-1')).toThrow(/path does not match/i);
  });

  it('rejects incomplete, corrupt, and non-contiguous generation chains actionably', () => {
    const incomplete = createQueueWithRoot();
    incomplete.queue.enqueue(makeQuestion());
    rmSync(join(generationsDirectory(incomplete.root), '000000000000.json'));
    expect(() => incomplete.queue.list()).toThrow(/missing generation/i);

    const corrupt = createQueueWithRoot();
    corrupt.queue.enqueue(makeQuestion());
    corrupt.queue.claim('question-1', 'agent-a', NOW, 60_000);
    const second = join(generationsDirectory(corrupt.root), '000000000001.json');
    const value = JSON.parse(readFileSync(second, 'utf8')) as Record<string, unknown>;
    writeFileSync(second, `${JSON.stringify({ ...value, predecessorHash: 'bad-hash' })}\n`);
    expect(() => corrupt.queue.list()).toThrow(/predecessor hash/i);

    const gap = createQueueWithRoot();
    gap.queue.enqueue(makeQuestion());
    writeFileSync(
      join(generationsDirectory(gap.root), '000000000002.json'),
      readFileSync(join(generationsDirectory(gap.root), '000000000000.json')),
    );
    expect(() => gap.queue.list()).toThrow(/contiguous/i);
  });

  it('rejects hash-correct illegal transitions and changed carried fields', () => {
    const illegal = createQueueWithRoot();
    illegal.queue.enqueue(makeQuestion());
    illegal.queue.claim('question-1', 'agent-a', NOW, 60_000);
    const claimedPath = join(generationsDirectory(illegal.root), '000000000001.json');
    const claimed = JSON.parse(readFileSync(claimedPath, 'utf8')) as Record<string, unknown>;
    writeFileSync(
      claimedPath,
      `${JSON.stringify(
        {
          ...claimed,
          state: 'queued',
          claim: undefined,
        },
        null,
        2,
      )}\n`,
    );
    expect(() => illegal.queue.list()).toThrow(/illegal.*transition/i);

    const changed = createQueueWithRoot();
    changed.queue.enqueue(makeQuestion());
    const first = changed.queue.claim('question-1', 'agent-a', NOW, 60_000);
    changed.queue.renew('question-1', 'agent-a', claimToken(first.question), NOW + 1, 60_000);
    const renewedPath = join(generationsDirectory(changed.root), '000000000002.json');
    const renewed = JSON.parse(readFileSync(renewedPath, 'utf8')) as Record<string, unknown>;
    const renewedClaim = renewed.claim as Record<string, unknown>;
    writeFileSync(
      renewedPath,
      `${JSON.stringify(
        {
          ...renewed,
          claim: { ...renewedClaim, claimedAt: new Date(NOW + 1).toISOString() },
        },
        null,
        2,
      )}\n`,
    );
    expect(() => changed.queue.list()).toThrow(/claim identity|carry/i);
  });

  it('rejects traversal in a hash-correct pending claim token and deterministic answer id', () => {
    let crashed = false;
    const { root, queue } = createQueueWithRoot({
      afterPublish: (publication) => {
        if (
          !crashed &&
          publication.kind === 'generation' &&
          publication.state === 'answer-pending'
        ) {
          crashed = true;
          throw new Error('crash after pending');
        }
      },
    });
    queue.enqueue(makeQuestion());
    const claimed = queue.claim('question-1', 'agent-a', NOW, 60_000);
    expect(() =>
      queue.answer('question-1', 'agent-a', claimToken(claimed.question), BODY, NOW + 1),
    ).toThrow('crash after pending');

    const pendingPath = join(generationsDirectory(root), '000000000002.json');
    const pending = JSON.parse(readFileSync(pendingPath, 'utf8')) as ReviewQuestionGeneration;
    if (!pending.claim || !pending.answer) throw new Error('test expected pending authority');
    const traversalToken = '../../../outside';
    writeFileSync(
      pendingPath,
      `${JSON.stringify(
        {
          ...pending,
          claim: { ...pending.claim, token: traversalToken },
          answer: {
            ...pending.answer,
            id: `answer-question-1-${traversalToken}`,
          },
        },
        null,
        2,
      )}\n`,
    );

    expect(() => queue.list()).toThrow(/invalid review (claim token|question generation)/i);
  });

  it('accepts generated safe claim tokens and their deterministic answer ids', () => {
    const { queue } = createQueueWithRoot();
    queue.enqueue(makeQuestion());
    const claimed = queue.claim('question-1', 'agent-a', NOW, 60_000);
    const token = claimToken(claimed.question);

    expect(token).toMatch(SAFE_SEGMENT);
    const answer = queue.answer('question-1', 'agent-a', token, BODY, NOW + 1);
    expect(answer.id).toBe(`answer-question-1-${token}`);
    expect(queue.readAnswer(answer.id)).toEqual(answer);
  });
});

describe('durable no-overwrite publication', () => {
  it('fsyncs each file and its parent directory before reporting publication', () => {
    const events: string[] = [];
    const { queue } = createQueueWithRoot({
      afterFileFsync: (publication) => events.push(`file:${publication.kind}`),
      afterDirectoryFsync: (publication) => events.push(`directory:${publication.kind}`),
    });

    queue.enqueue(makeQuestion());

    expect(events).toEqual([
      'file:generation',
      'directory:generation',
      'file:question',
      'directory:question',
    ]);
  });

  it('fails cleanly when hard-link publication is unsupported', () => {
    const unsupported = Object.assign(new Error('links unsupported'), { code: 'ENOTSUP' });
    const { queue } = createQueueWithRoot({
      link: (_temporary, _destination, publication) => {
        if (publication.kind === 'question') throw unsupported;
        linkSync(_temporary, _destination);
      },
    });

    expect(() => queue.enqueue(makeQuestion())).toThrow(/hard-link publication is unsupported/i);
  });

  it('surfaces pre-publication fsync failure and reconciles ambiguous committed fsync', () => {
    const fileFailure = createQueueWithRoot({
      beforeFileFsync: (publication) => {
        if (publication.kind === 'question') throw new Error('file fsync failed');
      },
    });
    expect(() => fileFailure.queue.enqueue(makeQuestion())).toThrow('file fsync failed');
    expect(existsSync(join(questionDirectory(fileFailure.root), 'question-1.json'))).toBe(false);

    const directoryFailure = createQueueWithRoot({
      beforeDirectoryFsync: (publication) => {
        if (publication.kind === 'generation') throw new Error('directory fsync failed');
      },
    });
    expect(directoryFailure.queue.enqueue(makeQuestion()).status).toBe('queued');
    expect(directoryFailure.queue.list()).toHaveLength(1);
  });

  it('fsyncs the generation directory parent and retries after its failure', () => {
    let failed = false;
    const { root, queue } = createQueueWithRoot({
      beforeParentDirectoryFsync: (publication) => {
        if (!failed && publication.kind === 'generation') {
          failed = true;
          throw new Error('generation parent fsync failed');
        }
      },
    });

    expect(() => queue.enqueue(makeQuestion())).toThrow('generation parent fsync failed');
    expect(createQuestionQueue(root, REFERENCE).list()).toEqual([]);
    expect(createQuestionQueue(root, REFERENCE).enqueue(makeQuestion()).status).toBe('queued');
  });

  it('treats temporary cleanup failure after publication as non-fatal', () => {
    const cleaned: QuestionPublication[] = [];
    const { queue } = createQueueWithRoot({
      cleanupTemporary: (_path, publication) => {
        cleaned.push(publication);
        throw new Error('cleanup failed');
      },
    });

    expect(queue.enqueue(makeQuestion()).id).toBe('question-1');
    expect(cleaned.map((publication) => publication.kind)).toEqual(['generation', 'question']);
    expect(queue.readQuestion('question-1')?.status).toBe('queued');
  });
});
