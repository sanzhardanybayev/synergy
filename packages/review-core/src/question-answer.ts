import { existsSync } from 'node:fs';
import {
  errorCode,
  isExactCommittedPublication,
  publishExclusiveText,
  serializeJson,
} from './durable-publication.js';
import type { QuestionPersistenceOptions } from './durable-publication.js';
import { hashText } from './hash.js';
import { assertReviewArtifactPath } from './paths.js';
import { loadQuestionState, nextGeneration, tryPublishGeneration } from './question-chain.js';
import {
  answerFile,
  answerId,
  expectedAnswer,
  readAuthoritativeSnapshot,
  readPendingAnswer,
} from './question-generations.js';
import { isActiveClaim } from './question-transitions.js';
import { assertReviewAnswer } from './schema.js';
import type { ReviewAnswer, ReviewAnswerReference, ReviewRef } from './types.js';

export function writeAnswerWithOptions(
  projectRoot: string,
  reference: ReviewRef,
  questionId: string,
  listenerId: string,
  claimToken: string,
  body: string,
  now: number,
  options: QuestionPersistenceOptions,
): ReviewAnswer {
  if (body.trim().length === 0) throw new Error('review answer body must not be empty');
  const snapshot = readAuthoritativeSnapshot(projectRoot, reference);
  while (true) {
    let state = loadQuestionState(projectRoot, reference, snapshot, questionId);
    let current = state.chain.current;
    if (current.state === 'answered') {
      const referenceData = current.answer;
      if (!referenceData) throw new Error('answered generation is missing answer data');
      const answer = readPendingAnswer(projectRoot, reference, questionId, referenceData);
      if (
        answer &&
        referenceData.listenerId === listenerId &&
        referenceData.bodyHash === hashText(body)
      ) {
        return answer;
      }
      throw new Error('review question claim is not owned by this listener');
    }
    if (current.state === 'claimed') {
      if (!isActiveClaim(current, listenerId, claimToken, now)) {
        throw new Error('review question claim is not owned by this listener');
      }
      const answerReference: ReviewAnswerReference = {
        id: answerId(questionId, claimToken),
        listenerId,
        bodyHash: hashText(body),
        createdAt: new Date(now).toISOString(),
      };
      const pending = nextGeneration(state, 'answer-pending', now, {
        claim: current.claim,
        answer: answerReference,
      });
      if (!tryPublishGeneration(projectRoot, reference, pending, options)) continue;
      state = loadQuestionState(projectRoot, reference, snapshot, questionId);
      current = state.chain.current;
    }
    if (
      current.state !== 'answer-pending' ||
      !isActiveClaim(current, listenerId, claimToken, now) ||
      current.answer?.bodyHash !== hashText(body)
    ) {
      throw new Error('review question claim is not owned by this listener');
    }
    const answerReference = current.answer;
    const answer = expectedAnswer(reference, questionId, answerReference, body);
    assertReviewAnswer(answer);
    const path = answerFile(projectRoot, reference, answer.id);
    if (!existsSync(path)) {
      try {
        publishExclusiveText(
          path,
          serializeJson(answer),
          { kind: 'answer', path, questionId },
          options,
          () => {
            const authorized = loadQuestionState(projectRoot, reference, snapshot, questionId).chain
              .current;
            if (
              authorized.state !== 'answer-pending' ||
              !isActiveClaim(authorized, listenerId, claimToken, now) ||
              authorized.answer?.bodyHash !== answerReference.bodyHash
            ) {
              throw new Error('review question claim is not owned by this listener');
            }
          },
          () => assertReviewArtifactPath(projectRoot, path),
        );
      } catch (error) {
        if (!isExactCommittedPublication(error) && errorCode(error) !== 'EEXIST') throw error;
      }
    }
    const persisted = readPendingAnswer(projectRoot, reference, questionId, answerReference);
    if (!persisted) throw new Error('immutable review answer publication did not complete');
    state = loadQuestionState(projectRoot, reference, snapshot, questionId);
    current = state.chain.current;
    if (current.state === 'answered') return persisted;
    if (
      current.state !== 'answer-pending' ||
      current.answer?.bodyHash !== answerReference.bodyHash
    ) {
      throw new Error('review answer lost authorization before finalization');
    }
    const answered = nextGeneration(state, 'answered', now, { answer: answerReference });
    if (tryPublishGeneration(projectRoot, reference, answered, options)) return persisted;
  }
}
