import { existsSync } from 'node:fs';
import {
  errorCode,
  isExactCommittedPublication,
  publishExclusiveText,
  serializeJson,
} from './durable-publication.js';
import type { QuestionPersistenceOptions } from './durable-publication.js';
import { hashText } from './hash.js';
import { assertSafeReviewSegment } from './ids.js';
import { assertReviewArtifactPath } from './paths.js';
import {
  generationFile,
  hydrateQuestion,
  questionFile,
  readEnvelopeArtifact,
  readGenerationChain,
  tryPublishGeneration,
  validateQuestionRelationship,
} from './question-chain.js';
import { readAuthoritativeSnapshot } from './question-generations.js';
import { assertReviewQuestionEnvelope } from './schema.js';
import type {
  ReviewQuestion,
  ReviewQuestionEnvelope,
  ReviewQuestionGeneration,
  ReviewQuestionInput,
  ReviewRef,
} from './types.js';

export function enqueueQuestionWithOptions(
  projectRoot: string,
  reference: ReviewRef,
  question: ReviewQuestionInput,
  options: QuestionPersistenceOptions,
): ReviewQuestion {
  assertSafeReviewSegment(question.id, 'question');
  const snapshot = readAuthoritativeSnapshot(projectRoot, reference);
  const envelope: ReviewQuestionEnvelope = {
    ...question,
    schemaVersion: 1,
    workspaceId: reference.workspaceId,
    revisionId: reference.revisionId,
  };
  assertReviewQuestionEnvelope(envelope);
  validateQuestionRelationship(envelope, reference, snapshot);
  const envelopeRaw = serializeJson(envelope);
  const envelopeHash = hashText(envelopeRaw);
  const initial: ReviewQuestionGeneration = {
    schemaVersion: 1,
    questionId: question.id,
    workspaceId: reference.workspaceId,
    revisionId: reference.revisionId,
    generation: 0,
    predecessorGeneration: null,
    predecessorHash: null,
    envelopeHash,
    state: 'queued',
    publishedAt: question.createdAt,
  };
  const initialPath = generationFile(projectRoot, reference, question.id, 0);
  if (!existsSync(initialPath)) {
    tryPublishGeneration(projectRoot, reference, initial, options);
  }
  const chain = readGenerationChain(projectRoot, reference, question.id);
  if (chain.current.envelopeHash !== envelopeHash) {
    throw new Error(`review question ${question.id} enqueue content conflicts with generation 0`);
  }
  const path = questionFile(projectRoot, reference, question.id);
  if (!existsSync(path)) {
    try {
      publishExclusiveText(
        path,
        envelopeRaw,
        { kind: 'question', path, questionId: question.id },
        options,
        undefined,
        () => assertReviewArtifactPath(projectRoot, path),
      );
    } catch (error) {
      if (!isExactCommittedPublication(error) && errorCode(error) !== 'EEXIST') throw error;
    }
  }
  const persistedEnvelope = readEnvelopeArtifact(path);
  if (persistedEnvelope.raw !== envelopeRaw) {
    throw new Error(
      `review question ${question.id} enqueue content does not match existing envelope`,
    );
  }
  return hydrateQuestion(persistedEnvelope.value, chain.current);
}
