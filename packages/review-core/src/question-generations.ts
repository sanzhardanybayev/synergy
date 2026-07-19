import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { serializeJson } from './durable-publication.js';
import { hashText } from './hash.js';
import { assertSafeReviewSegment } from './ids.js';
import {
  answersDir,
  assertReviewArtifactPath,
  reviewRevisionDir,
  snapshotFile,
  workspaceFile,
} from './paths.js';
import { hydrateQuestion, loadQuestionState, questionDirectory } from './question-chain.js';
import {
  assertReviewAnswer,
  assertReviewInsights,
  assertReviewProgress,
  assertReviewSnapshot,
  assertReviewWorkspace,
} from './schema.js';
import type {
  ReviewAnswer,
  ReviewAnswerReference,
  ReviewQuestion,
  ReviewRef,
  ReviewSnapshot,
} from './types.js';

export interface QuestionArtifacts {
  questions: ReviewQuestion[];
  answers: ReviewAnswer[];
}

function readArtifact(path: string): { raw: string; value: unknown } {
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

export function answerFile(projectRoot: string, reference: ReviewRef, id: string): string {
  assertSafeReviewSegment(id, 'answer');
  return assertReviewArtifactPath(
    projectRoot,
    join(answersDir(projectRoot, reference.workspaceId, reference.revisionId), `${id}.json`),
  );
}

export function answerId(questionId: string, claimToken: string): string {
  assertSafeReviewSegment(questionId, 'question');
  assertSafeReviewSegment(claimToken, 'claim token');
  const id = `answer-${questionId}-${claimToken}`;
  assertSafeReviewSegment(id, 'answer');
  return id;
}

export function readAuthoritativeSnapshot(
  projectRoot: string,
  reference: ReviewRef,
): ReviewSnapshot {
  const workspaceArtifact = readArtifact(workspaceFile(projectRoot, reference.workspaceId));
  assertReviewWorkspace(workspaceArtifact.value);
  if (workspaceArtifact.value.id !== reference.workspaceId) {
    throw new Error('review workspace id does not match requested workspace');
  }

  const bundlePath = assertReviewArtifactPath(
    projectRoot,
    join(
      reviewRevisionDir(projectRoot, reference.workspaceId, reference.revisionId),
      'bundle.json',
    ),
  );
  let snapshot: ReviewSnapshot;
  if (existsSync(bundlePath)) {
    const bundle = readArtifact(bundlePath).value;
    if (
      typeof bundle !== 'object' ||
      bundle === null ||
      !('schemaVersion' in bundle) ||
      bundle.schemaVersion !== 1 ||
      !('finalized' in bundle) ||
      bundle.finalized !== true ||
      !('snapshot' in bundle) ||
      !('insights' in bundle) ||
      !('progress' in bundle)
    ) {
      throw new Error(`invalid finalized review bundle ${bundlePath}`);
    }
    assertReviewSnapshot(bundle.snapshot);
    assertReviewInsights(bundle.insights);
    assertReviewProgress(bundle.progress);
    snapshot = bundle.snapshot;
  } else {
    const snapshotArtifact = readArtifact(
      snapshotFile(projectRoot, reference.workspaceId, reference.revisionId),
    );
    assertReviewSnapshot(snapshotArtifact.value);
    snapshot = snapshotArtifact.value;
  }
  if (snapshot.revisionId !== reference.revisionId) {
    throw new Error('review snapshot revision does not match requested revision');
  }
  return snapshot;
}

export function expectedAnswer(
  reference: ReviewRef,
  questionId: string,
  answerReference: ReviewAnswerReference,
  body: string,
): ReviewAnswer {
  return {
    schemaVersion: 1,
    id: answerReference.id,
    questionId,
    workspaceId: reference.workspaceId,
    revisionId: reference.revisionId,
    listenerId: answerReference.listenerId,
    body,
    createdAt: answerReference.createdAt,
  };
}

export function readPendingAnswer(
  projectRoot: string,
  reference: ReviewRef,
  questionId: string,
  answerReference: ReviewAnswerReference,
): ReviewAnswer | undefined {
  const path = answerFile(projectRoot, reference, answerReference.id);
  if (!existsSync(path)) return undefined;
  const artifact = readArtifact(path);
  assertReviewAnswer(artifact.value);
  const answer = artifact.value;
  const expected = expectedAnswer(reference, questionId, answerReference, answer.body);
  if (
    hashText(answer.body) !== answerReference.bodyHash ||
    serializeJson(expected) !== artifact.raw
  ) {
    throw new Error(`review answer ${answer.id} does not match pending answer bytes`);
  }
  return answer;
}

export function readQuestionArtifacts(
  projectRoot: string,
  reference: ReviewRef,
  snapshot = readAuthoritativeSnapshot(projectRoot, reference),
): QuestionArtifacts {
  const directory = questionDirectory(projectRoot, reference);
  if (!existsSync(directory)) return { questions: [], answers: [] };
  const questions: ReviewQuestion[] = [];
  const answers: ReviewAnswer[] = [];
  for (const entry of readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .sort()) {
    const questionId = entry.slice(0, -'.json'.length);
    const state = loadQuestionState(projectRoot, reference, snapshot, questionId);
    questions.push(hydrateQuestion(state.envelope, state.chain.current));
    const answerReference = state.chain.current.answer;
    if (answerReference) {
      const answer = readPendingAnswer(projectRoot, reference, questionId, answerReference);
      if (state.chain.current.state === 'answered' && !answer) {
        throw new Error(`answered review question ${questionId} is missing its immutable answer`);
      }
      if (answer) answers.push(answer);
    }
  }
  return { questions, answers: answers.sort((left, right) => left.id.localeCompare(right.id)) };
}
