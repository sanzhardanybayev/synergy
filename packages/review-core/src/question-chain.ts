import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  errorCode,
  isExactCommittedPublication,
  publishExclusiveText,
  serializeJson,
} from './durable-publication.js';
import type { QuestionPersistenceOptions } from './durable-publication.js';
import { hashText } from './hash.js';
import { assertSafeReviewSegment } from './ids.js';
import { assertReviewArtifactPath, questionsDir } from './paths.js';
import { resolveReviewItemContext, resolveReviewLineSelection } from './review-lines.js';
import { assertReviewQuestionEnvelope, assertReviewQuestionGeneration } from './schema.js';
import type {
  ReviewAnswerReference,
  ReviewClaim,
  ReviewQuestion,
  ReviewQuestionEnvelope,
  ReviewQuestionGeneration,
  ReviewQuestionGenerationState,
  ReviewRef,
  ReviewSnapshot,
} from './types.js';

const GENERATION_NAME = /^(\d{12})\.json$/;

export interface GenerationChain {
  current: ReviewQuestionGeneration;
  currentHash: string;
}

export interface QuestionState {
  envelope: ReviewQuestionEnvelope;
  chain: GenerationChain;
}

interface Artifact<T> {
  raw: string;
  value: T;
}

export function questionDirectory(projectRoot: string, reference: ReviewRef): string {
  return questionsDir(projectRoot, reference.workspaceId, reference.revisionId);
}

export function questionFile(
  projectRoot: string,
  reference: ReviewRef,
  questionId: string,
): string {
  assertSafeReviewSegment(questionId, 'question');
  return assertReviewArtifactPath(
    projectRoot,
    join(questionDirectory(projectRoot, reference), `${questionId}.json`),
  );
}

function generationsDirectory(
  projectRoot: string,
  reference: ReviewRef,
  questionId: string,
): string {
  assertSafeReviewSegment(questionId, 'question');
  return assertReviewArtifactPath(
    projectRoot,
    join(questionDirectory(projectRoot, reference), `${questionId}.generations`),
  );
}

export function generationFile(
  projectRoot: string,
  reference: ReviewRef,
  questionId: string,
  generation: number,
): string {
  return assertReviewArtifactPath(
    projectRoot,
    join(
      generationsDirectory(projectRoot, reference, questionId),
      `${generation.toString().padStart(12, '0')}.json`,
    ),
  );
}

function readUnknownArtifact(path: string): Artifact<unknown> {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`unable to read review artifact ${path}: ${detail}`);
  }
  try {
    return { raw, value: JSON.parse(raw) };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`invalid JSON in review artifact ${path}: ${detail}`);
  }
}

export function readEnvelopeArtifact(path: string): Artifact<ReviewQuestionEnvelope> {
  const artifact = readUnknownArtifact(path);
  const envelope = artifact.value;
  assertReviewQuestionEnvelope(envelope);
  return { raw: artifact.raw, value: envelope };
}

export function validateQuestionRelationship(
  envelope: ReviewQuestionEnvelope,
  reference: ReviewRef,
  snapshot: ReviewSnapshot,
): void {
  if (
    envelope.workspaceId !== reference.workspaceId ||
    envelope.revisionId !== reference.revisionId
  ) {
    throw new Error('review question identity does not match requested bundle');
  }
  const item = snapshot.items.find((candidate) => candidate.id === envelope.reviewItemId);
  if (!item) throw new Error('review question references an unknown review item');
  if (item.path !== envelope.path) {
    throw new Error('review question path does not match its review item');
  }
  const canonicalContext = resolveReviewItemContext(snapshot, item.id);
  if (JSON.stringify(envelope.itemContext) !== JSON.stringify(canonicalContext)) {
    throw new Error('review question item context does not match its immutable review item');
  }
  const canonicalSelection = resolveReviewLineSelection(
    snapshot,
    item.id,
    envelope.selection.selectedLineIds,
  );
  if (
    envelope.selection.kind !== canonicalSelection.kind ||
    envelope.selection.selectedLineIds.some(
      (lineId, index) => lineId !== canonicalSelection.selectedLineIds[index],
    )
  ) {
    throw new Error('review question selection does not match its immutable review item');
  }
}

function sameClaim(left: ReviewClaim | undefined, right: ReviewClaim | undefined): boolean {
  return (
    left?.listenerId === right?.listenerId &&
    left?.token === right?.token &&
    left?.claimedAt === right?.claimedAt &&
    left?.expiresAt === right?.expiresAt
  );
}

function sameClaimIdentity(left: ReviewClaim | undefined, right: ReviewClaim | undefined): boolean {
  return (
    left?.listenerId === right?.listenerId &&
    left?.token === right?.token &&
    left?.claimedAt === right?.claimedAt
  );
}

function sameAnswer(
  left: ReviewAnswerReference | undefined,
  right: ReviewAnswerReference | undefined,
): boolean {
  return (
    left?.id === right?.id &&
    left?.listenerId === right?.listenerId &&
    left?.bodyHash === right?.bodyHash &&
    left?.createdAt === right?.createdAt
  );
}

function assertLegalTransition(
  previous: ReviewQuestionGeneration,
  current: ReviewQuestionGeneration,
): void {
  if (current.envelopeHash !== previous.envelopeHash) {
    throw new Error('review question generation changed its immutable envelope hash');
  }
  if (Date.parse(current.publishedAt) < Date.parse(previous.publishedAt)) {
    throw new Error('review question generation publication time moved backwards');
  }
  if (previous.state === 'queued') {
    if (current.state !== 'claimed') {
      throw new Error(`illegal review question transition queued -> ${current.state}`);
    }
    return;
  }
  if (previous.state === 'claimed') {
    if (current.state === 'queued') return;
    if (current.state === 'failed') return;
    if (current.state === 'answer-pending') {
      if (!sameClaim(previous.claim, current.claim)) {
        throw new Error('review question answer-pending transition changed claim identity');
      }
      return;
    }
    if (current.state === 'claimed') {
      if (previous.claim?.token === current.claim?.token) {
        if (!sameClaimIdentity(previous.claim, current.claim)) {
          throw new Error('review question renew changed claim identity carry-forward fields');
        }
        return;
      }
      if (
        Date.parse(previous.claim?.expiresAt ?? '') <= Date.parse(current.publishedAt) &&
        current.claim?.claimedAt === current.publishedAt
      ) {
        return;
      }
    }
    throw new Error(`illegal review question transition claimed -> ${current.state}`);
  }
  if (previous.state === 'answer-pending') {
    if (current.state === 'answered') {
      if (!sameAnswer(previous.answer, current.answer)) {
        throw new Error('review question answered transition changed answer carry-forward fields');
      }
      return;
    }
    if (
      current.state === 'queued' &&
      Date.parse(previous.claim?.expiresAt ?? '') <= Date.parse(current.publishedAt)
    ) {
      return;
    }
    if (current.state === 'failed') return;
    throw new Error(`illegal review question transition answer-pending -> ${current.state}`);
  }
  if (previous.state === 'failed') {
    if (current.state === 'claimed' && current.claim?.claimedAt === current.publishedAt) return;
    throw new Error(`illegal review question transition failed -> ${current.state}`);
  }
  throw new Error(`illegal review question transition from terminal state ${previous.state}`);
}

export function readGenerationChain(
  projectRoot: string,
  reference: ReviewRef,
  questionId: string,
): GenerationChain {
  const directory = generationsDirectory(projectRoot, reference, questionId);
  if (!existsSync(directory)) {
    throw new Error(`review question ${questionId} is missing its generation log`);
  }
  const files = readdirSync(directory)
    .filter((entry) => GENERATION_NAME.test(entry))
    .sort();
  if (files.length === 0) {
    throw new Error(`review question ${questionId} is missing generation 0`);
  }
  let previousRaw: string | undefined;
  let previous: ReviewQuestionGeneration | undefined;
  for (let index = 0; index < files.length; index += 1) {
    const expected = `${index.toString().padStart(12, '0')}.json`;
    const file = files[index];
    if (file !== expected) {
      throw new Error(`review question ${questionId} generation chain must be contiguous`);
    }
    const artifact = readUnknownArtifact(join(directory, file));
    assertReviewQuestionGeneration(artifact.value);
    const generation = artifact.value;
    if (
      generation.questionId !== questionId ||
      generation.workspaceId !== reference.workspaceId ||
      generation.revisionId !== reference.revisionId ||
      generation.generation !== index
    ) {
      throw new Error(`review question ${questionId} generation identity is corrupt`);
    }
    if (index === 0) {
      if (generation.state !== 'queued') {
        throw new Error(`review question ${questionId} initial generation must be queued`);
      }
    } else {
      if (generation.predecessorHash !== hashText(previousRaw ?? '')) {
        throw new Error(`review question ${questionId} generation predecessor hash is invalid`);
      }
      if (!previous) throw new Error(`review question ${questionId} predecessor is incomplete`);
      assertLegalTransition(previous, generation);
    }
    previousRaw = artifact.raw;
    previous = generation;
  }
  if (!previous || previousRaw === undefined) {
    throw new Error(`review question ${questionId} has an incomplete generation chain`);
  }
  return { current: previous, currentHash: hashText(previousRaw) };
}

export function loadQuestionState(
  projectRoot: string,
  reference: ReviewRef,
  snapshot: ReviewSnapshot,
  questionId: string,
): QuestionState {
  const path = questionFile(projectRoot, reference, questionId);
  if (!existsSync(path)) throw new Error('review question does not exist');
  const envelopeArtifact = readEnvelopeArtifact(path);
  if (envelopeArtifact.value.id !== questionId) {
    throw new Error('review question file identity is corrupt');
  }
  validateQuestionRelationship(envelopeArtifact.value, reference, snapshot);
  const chain = readGenerationChain(projectRoot, reference, questionId);
  if (chain.current.envelopeHash !== hashText(envelopeArtifact.raw)) {
    throw new Error('review question envelope does not match its generation authority');
  }
  return { envelope: envelopeArtifact.value, chain };
}

export function hydrateQuestion(
  envelope: ReviewQuestionEnvelope,
  generation: ReviewQuestionGeneration,
): ReviewQuestion {
  const status: ReviewQuestion['status'] =
    generation.state === 'claimed' || generation.state === 'answer-pending'
      ? 'processing'
      : generation.state;
  return {
    ...envelope,
    generation: generation.generation,
    status,
    ...(generation.claim ? { claim: generation.claim } : {}),
    ...(generation.failureMessage ? { failureMessage: generation.failureMessage } : {}),
  };
}

export function nextGeneration(
  state: QuestionState,
  nextState: ReviewQuestionGenerationState,
  now: number,
  fields: {
    claim?: ReviewQuestionGeneration['claim'];
    answer?: ReviewAnswerReference;
    failureMessage?: string;
  } = {},
): ReviewQuestionGeneration {
  return {
    schemaVersion: 1,
    questionId: state.envelope.id,
    workspaceId: state.envelope.workspaceId,
    revisionId: state.envelope.revisionId,
    generation: state.chain.current.generation + 1,
    predecessorGeneration: state.chain.current.generation,
    predecessorHash: state.chain.currentHash,
    envelopeHash: state.chain.current.envelopeHash,
    state: nextState,
    publishedAt: new Date(now).toISOString(),
    ...fields,
  };
}

export function tryPublishGeneration(
  projectRoot: string,
  reference: ReviewRef,
  generation: ReviewQuestionGeneration,
  options: QuestionPersistenceOptions,
): boolean {
  assertReviewQuestionGeneration(generation);
  const path = generationFile(projectRoot, reference, generation.questionId, generation.generation);
  const raw = serializeJson(generation);
  try {
    publishExclusiveText(
      path,
      raw,
      {
        kind: 'generation',
        path,
        questionId: generation.questionId,
        generation: generation.generation,
        state: generation.state,
      },
      options,
      undefined,
      () => assertReviewArtifactPath(projectRoot, path),
    );
    return true;
  } catch (error) {
    if (isExactCommittedPublication(error)) return true;
    if (errorCode(error) === 'EEXIST') return false;
    throw error;
  }
}
