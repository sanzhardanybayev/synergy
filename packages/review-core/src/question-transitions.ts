import { randomUUID } from 'node:crypto';
import type { QuestionPersistenceOptions } from './durable-publication.js';
import { assertSafeReviewSegment } from './ids.js';
import {
  hydrateQuestion,
  loadQuestionState,
  nextGeneration,
  tryPublishGeneration,
} from './question-chain.js';
import type { QuestionState } from './question-chain.js';
import {
  readAuthoritativeSnapshot,
  readPendingAnswer,
  readQuestionArtifacts,
} from './question-generations.js';
import type {
  ClaimResult,
  ReviewClaim,
  ReviewQuestion,
  ReviewQuestionGeneration,
  ReviewRef,
} from './types.js';

export function isActiveClaim(
  generation: ReviewQuestionGeneration,
  listenerId: string,
  claimToken: string,
  now: number,
): boolean {
  return (
    generation.claim?.listenerId === listenerId &&
    generation.claim.token === claimToken &&
    Date.parse(generation.claim.expiresAt) > now
  );
}

function assertClaimParameters(now: number, leaseMs: number): void {
  if (!Number.isFinite(now) || !Number.isFinite(leaseMs) || leaseMs <= 0) {
    throw new Error('review question claim requires a positive lease duration');
  }
}

function createClaim(listenerId: string, now: number, leaseMs: number): ReviewClaim {
  const token = randomUUID();
  assertSafeReviewSegment(token, 'claim token');
  return {
    listenerId,
    token,
    claimedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + leaseMs).toISOString(),
  };
}

function reconcilePending(
  projectRoot: string,
  reference: ReviewRef,
  state: QuestionState,
  now: number,
  options: QuestionPersistenceOptions,
): 'retry' | 'answered' {
  const answerReference = state.chain.current.answer;
  if (!answerReference) {
    throw new Error('answer-pending generation is missing its answer reference');
  }
  const answer = readPendingAnswer(projectRoot, reference, state.envelope.id, answerReference);
  const generation = answer
    ? nextGeneration(state, 'answered', now, { answer: answerReference })
    : nextGeneration(state, 'queued', now);
  if (!tryPublishGeneration(projectRoot, reference, generation, options)) return 'retry';
  return answer ? 'answered' : 'retry';
}

export function claimQuestionWithOptions(
  projectRoot: string,
  reference: ReviewRef,
  questionId: string,
  listenerId: string,
  now: number,
  leaseMs: number,
  options: QuestionPersistenceOptions,
): ClaimResult {
  assertClaimParameters(now, leaseMs);
  assertSafeReviewSegment(questionId, 'question');
  assertSafeReviewSegment(listenerId, 'listener');
  const snapshot = readAuthoritativeSnapshot(projectRoot, reference);
  while (true) {
    const state = loadQuestionState(projectRoot, reference, snapshot, questionId);
    const current = state.chain.current;
    if (current.state === 'answered' || current.state === 'stale') return { ok: false };
    if (current.state === 'answer-pending') {
      if (Date.parse(current.claim?.expiresAt ?? '') > now) return { ok: false };
      const reconciled = reconcilePending(projectRoot, reference, state, now, options);
      if (reconciled === 'answered') return { ok: false };
      continue;
    }
    if (current.state === 'claimed' && Date.parse(current.claim?.expiresAt ?? '') > now) {
      return { ok: false };
    }
    const claim = createClaim(listenerId, now, leaseMs);
    const generation = nextGeneration(state, 'claimed', now, { claim });
    if (tryPublishGeneration(projectRoot, reference, generation, options)) {
      return { ok: true, question: hydrateQuestion(state.envelope, generation) };
    }
  }
}

export function renewClaimWithOptions(
  projectRoot: string,
  reference: ReviewRef,
  questionId: string,
  listenerId: string,
  claimToken: string,
  now: number,
  leaseMs: number,
  options: QuestionPersistenceOptions,
): ClaimResult {
  assertClaimParameters(now, leaseMs);
  const snapshot = readAuthoritativeSnapshot(projectRoot, reference);
  while (true) {
    const state = loadQuestionState(projectRoot, reference, snapshot, questionId);
    const current = state.chain.current;
    if (
      current.state !== 'claimed' ||
      !current.claim ||
      !isActiveClaim(current, listenerId, claimToken, now)
    ) {
      return { ok: false };
    }
    const claim: ReviewClaim = {
      ...current.claim,
      expiresAt: new Date(now + leaseMs).toISOString(),
    };
    const generation = nextGeneration(state, 'claimed', now, { claim });
    if (tryPublishGeneration(projectRoot, reference, generation, options)) {
      return { ok: true, question: hydrateQuestion(state.envelope, generation) };
    }
  }
}

export function releaseClaimWithOptions(
  projectRoot: string,
  reference: ReviewRef,
  questionId: string,
  listenerId: string,
  claimToken: string,
  now: number,
  options: QuestionPersistenceOptions,
): boolean {
  const snapshot = readAuthoritativeSnapshot(projectRoot, reference);
  while (true) {
    const state = loadQuestionState(projectRoot, reference, snapshot, questionId);
    const current = state.chain.current;
    if (current.state !== 'claimed' || !isActiveClaim(current, listenerId, claimToken, now)) {
      return false;
    }
    if (
      tryPublishGeneration(projectRoot, reference, nextGeneration(state, 'queued', now), options)
    ) {
      return true;
    }
  }
}

export function failQuestionWithOptions(
  projectRoot: string,
  reference: ReviewRef,
  questionId: string,
  listenerId: string,
  claimToken: string,
  failureMessage: string,
  now: number,
  options: QuestionPersistenceOptions,
): boolean {
  if (failureMessage.trim().length === 0) {
    throw new Error('review question failure message must not be empty');
  }
  assertSafeReviewSegment(questionId, 'question');
  assertSafeReviewSegment(listenerId, 'listener');
  assertSafeReviewSegment(claimToken, 'claim token');
  const snapshot = readAuthoritativeSnapshot(projectRoot, reference);
  while (true) {
    const state = loadQuestionState(projectRoot, reference, snapshot, questionId);
    const current = state.chain.current;
    if (
      (current.state !== 'claimed' && current.state !== 'answer-pending') ||
      !isActiveClaim(current, listenerId, claimToken, now)
    ) {
      return false;
    }
    if (current.state === 'answer-pending' && current.answer) {
      const answer = readPendingAnswer(projectRoot, reference, questionId, current.answer);
      if (answer) {
        const answered = nextGeneration(state, 'answered', now, { answer: current.answer });
        if (tryPublishGeneration(projectRoot, reference, answered, options)) return false;
        continue;
      }
    }
    const failed = nextGeneration(state, 'failed', now, { failureMessage });
    if (tryPublishGeneration(projectRoot, reference, failed, options)) return true;
  }
}

export function reconcileExpiredQuestionsWithOptions(
  projectRoot: string,
  reference: ReviewRef,
  now: number,
  options: QuestionPersistenceOptions,
): ReviewQuestion[] {
  const snapshot = readAuthoritativeSnapshot(projectRoot, reference);
  const currentQuestions = readQuestionArtifacts(projectRoot, reference, snapshot).questions;
  for (const question of currentQuestions) {
    if (question.status !== 'processing' || Date.parse(question.claim?.expiresAt ?? '') > now) {
      continue;
    }
    while (true) {
      const state = loadQuestionState(projectRoot, reference, snapshot, question.id);
      const current = state.chain.current;
      if (
        (current.state !== 'claimed' && current.state !== 'answer-pending') ||
        Date.parse(current.claim?.expiresAt ?? '') > now
      ) {
        break;
      }
      if (current.state === 'answer-pending') {
        reconcilePending(projectRoot, reference, state, now, options);
      } else {
        tryPublishGeneration(projectRoot, reference, nextGeneration(state, 'queued', now), options);
      }
    }
  }
  return readQuestionArtifacts(projectRoot, reference, snapshot).questions;
}
