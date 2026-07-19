import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { atomicWriteJson } from './atomic.js';
import type { QuestionPersistenceOptions } from './durable-publication.js';
import { assertSafeReviewSegment } from './ids.js';
import { assertReviewArtifactPath } from './paths.js';
import { writeAnswerWithOptions } from './question-answer.js';
import {
  hydrateQuestion,
  loadQuestionState,
  questionDirectory,
  questionFile,
} from './question-chain.js';
import { enqueueQuestionWithOptions } from './question-enqueue.js';
import { readAuthoritativeSnapshot, readQuestionArtifacts } from './question-generations.js';
import type { QuestionArtifacts } from './question-generations.js';
import {
  claimQuestionWithOptions,
  failQuestionWithOptions,
  reconcileExpiredQuestionsWithOptions,
  releaseClaimWithOptions,
  renewClaimWithOptions,
} from './question-transitions.js';
import type {
  ClaimResult,
  QuestionQueue,
  ReviewAnswer,
  ReviewQuestion,
  ReviewQuestionInput,
  ReviewRef,
  ReviewSnapshot,
} from './types.js';

export type { QuestionPersistenceOptions, QuestionPublication } from './durable-publication.js';

const LISTENERS_DIRECTORY = '.listeners';

export type { ClaimResult, QuestionQueue, ReviewQuestionInput } from './types.js';

function listenerFile(projectRoot: string, reference: ReviewRef, listenerId: string): string {
  assertSafeReviewSegment(listenerId, 'listener');
  return assertReviewArtifactPath(
    projectRoot,
    join(questionDirectory(projectRoot, reference), LISTENERS_DIRECTORY, `${listenerId}.json`),
  );
}

export function enqueueQuestion(
  projectRoot: string,
  reference: ReviewRef,
  question: ReviewQuestionInput,
): ReviewQuestion {
  return enqueueQuestionWithOptions(projectRoot, reference, question, {});
}

export function listQuestions(projectRoot: string, reference: ReviewRef): ReviewQuestion[] {
  return readQuestionArtifacts(projectRoot, reference).questions;
}

export function reconcileExpiredQuestions(
  projectRoot: string,
  reference: ReviewRef,
  now = Date.now(),
): ReviewQuestion[] {
  return reconcileExpiredQuestionsWithOptions(projectRoot, reference, now, {});
}

export function claimQuestion(
  projectRoot: string,
  reference: ReviewRef,
  questionId: string,
  listenerId: string,
  now: number,
  leaseMs: number,
): ClaimResult {
  return claimQuestionWithOptions(projectRoot, reference, questionId, listenerId, now, leaseMs, {});
}

export function claimQuestions(
  projectRoot: string,
  reference: ReviewRef,
  listenerId: string,
  now: number,
  leaseMs: number,
): ReviewQuestion[] {
  return listQuestions(projectRoot, reference).flatMap((question) => {
    if (question.status === 'answered' || question.status === 'stale') return [];
    const result = claimQuestion(projectRoot, reference, question.id, listenerId, now, leaseMs);
    return result.ok && result.question ? [result.question] : [];
  });
}

export function renewClaim(
  projectRoot: string,
  reference: ReviewRef,
  questionId: string,
  listenerId: string,
  claimToken: string,
  now: number,
  leaseMs: number,
): ClaimResult {
  return renewClaimWithOptions(
    projectRoot,
    reference,
    questionId,
    listenerId,
    claimToken,
    now,
    leaseMs,
    {},
  );
}

export function releaseClaim(
  projectRoot: string,
  reference: ReviewRef,
  questionId: string,
  listenerId: string,
  claimToken: string,
  now: number,
): boolean {
  return releaseClaimWithOptions(
    projectRoot,
    reference,
    questionId,
    listenerId,
    claimToken,
    now,
    {},
  );
}

export function failQuestion(
  projectRoot: string,
  reference: ReviewRef,
  questionId: string,
  listenerId: string,
  claimToken: string,
  failureMessage: string,
  now: number,
): boolean {
  return failQuestionWithOptions(
    projectRoot,
    reference,
    questionId,
    listenerId,
    claimToken,
    failureMessage,
    now,
    {},
  );
}

export function writeAnswer(
  projectRoot: string,
  reference: ReviewRef,
  questionId: string,
  listenerId: string,
  claimToken: string,
  body: string,
  now: number,
): ReviewAnswer {
  return writeAnswerWithOptions(
    projectRoot,
    reference,
    questionId,
    listenerId,
    claimToken,
    body,
    now,
    {},
  );
}

export function touchReviewListener(
  projectRoot: string,
  reference: ReviewRef,
  listenerId: string,
  now = Date.now(),
): void {
  readAuthoritativeSnapshot(projectRoot, reference);
  assertSafeReviewSegment(listenerId, 'listener');
  const path = listenerFile(projectRoot, reference, listenerId);
  mkdirSync(dirname(path), { recursive: true });
  atomicWriteJson(path, { listenerId, updatedAt: new Date(now).toISOString() });
}

export function removeReviewListener(
  projectRoot: string,
  reference: ReviewRef,
  listenerId: string,
): void {
  assertSafeReviewSegment(listenerId, 'listener');
  rmSync(listenerFile(projectRoot, reference, listenerId), { force: true });
}

export function createQuestionQueue(
  projectRoot: string,
  reference: ReviewRef,
  options: QuestionPersistenceOptions = {},
): QuestionQueue {
  return {
    enqueue: (question) => enqueueQuestionWithOptions(projectRoot, reference, question, options),
    list: () => readQuestionArtifacts(projectRoot, reference).questions,
    claim: (questionId, listenerId, now, leaseMs) =>
      claimQuestionWithOptions(
        projectRoot,
        reference,
        questionId,
        listenerId,
        now,
        leaseMs,
        options,
      ),
    renew: (questionId, listenerId, claimToken, now, leaseMs) =>
      renewClaimWithOptions(
        projectRoot,
        reference,
        questionId,
        listenerId,
        claimToken,
        now,
        leaseMs,
        options,
      ),
    release: (questionId, listenerId, claimToken, now) =>
      releaseClaimWithOptions(
        projectRoot,
        reference,
        questionId,
        listenerId,
        claimToken,
        now,
        options,
      ),
    fail: (questionId, listenerId, claimToken, failureMessage, now) =>
      failQuestionWithOptions(
        projectRoot,
        reference,
        questionId,
        listenerId,
        claimToken,
        failureMessage,
        now,
        options,
      ),
    answer: (questionId, listenerId, claimToken, body, now) =>
      writeAnswerWithOptions(
        projectRoot,
        reference,
        questionId,
        listenerId,
        claimToken,
        body,
        now,
        options,
      ),
    readQuestion: (questionId) => {
      const path = questionFile(projectRoot, reference, questionId);
      if (!existsSync(path)) return undefined;
      const snapshot = readAuthoritativeSnapshot(projectRoot, reference);
      const state = loadQuestionState(projectRoot, reference, snapshot, questionId);
      return hydrateQuestion(state.envelope, state.chain.current);
    },
    readAnswer: (id) =>
      readQuestionArtifacts(projectRoot, reference).answers.find((answer) => answer.id === id),
    touchListener: (listenerId, now) =>
      touchReviewListener(projectRoot, reference, listenerId, now),
    removeListener: (listenerId) => removeReviewListener(projectRoot, reference, listenerId),
  };
}

export function loadReviewQuestionArtifacts(
  projectRoot: string,
  reference: ReviewRef,
  snapshot: ReviewSnapshot,
): QuestionArtifacts {
  return readQuestionArtifacts(projectRoot, reference, snapshot);
}

export function reviewQuestionsDirectory(projectRoot: string, reference: ReviewRef): string {
  return questionDirectory(projectRoot, reference);
}
