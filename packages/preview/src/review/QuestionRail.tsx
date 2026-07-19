import { resolveBrowserReviewItemContext } from '@synergy/review-core/browser';
import type { RefObject } from 'react';
import { useReview } from './ReviewProvider.js';

interface QuestionRailProps {
  questionInputRef: RefObject<HTMLTextAreaElement>;
}

const QUESTION_STATUS_LABELS = {
  queued: 'Question queued',
  processing: 'Processing',
  answered: 'Answered',
  failed: 'Failed — retryable',
  stale: 'Stale source',
} as const;

/** Exposes durable browser-to-agent work, presence, answers, and concrete completion blockers. */
export function QuestionRail({ questionInputRef }: QuestionRailProps) {
  const review = useReview();
  const bundle = review.bundle;
  const readiness = review.readiness;
  if (!bundle || !readiness) return null;
  const sourceVerificationUnavailable =
    review.captureFailed || review.interruptionCode === 'source_capture_failed';
  const connectionUnavailable =
    review.streamStatus === 'interrupted' || review.interruptionCode === 'review_unavailable';
  const connectionLabel =
    review.interruptionCode === 'review_unavailable'
      ? 'Review unavailable'
      : review.streamStatus === 'interrupted'
        ? 'Connection interrupted'
        : review.streamStatus === 'connecting'
          ? 'Connecting to agent…'
          : 'Connected';
  const activeQuestions = [...bundle.questions].sort((left, right) => {
    const timestampDifference = Date.parse(right.createdAt) - Date.parse(left.createdAt);
    return timestampDifference || left.id.localeCompare(right.id);
  });
  const activeItem = bundle.snapshot.items.find((item) => item.id === review.activeItemId);
  const hasSelectableLines = activeItem
    ? resolveBrowserReviewItemContext(bundle.snapshot, activeItem.id).rows.length > 0
    : false;
  const canFinish = readiness.ready && !sourceVerificationUnavailable;

  return (
    <aside className="review-question-rail" aria-label="Questions and readiness">
      <section className="review-agent-card">
        <div className="review-agent-card__heading">
          <div>
            <p className="review-eyebrow">Agent</p>
            <strong>{review.isListening ? 'Listening' : 'Not listening'}</strong>
          </div>
          <span
            className={`review-presence-dot${review.isListening ? ' is-listening' : ''}`}
            aria-hidden="true"
          />
        </div>
        <p className={connectionUnavailable ? 'review-tone--danger' : ''}>{connectionLabel}</p>
        {sourceVerificationUnavailable ? (
          <p className="review-tone--danger">Source verification unavailable</p>
        ) : null}
      </section>

      <section className="review-composer">
        <div className="review-composer__heading">
          <div>
            <p className="review-eyebrow">Ask about this item</p>
            <strong>
              {hasSelectableLines
                ? `${review.selectedLineIds.length} ${review.selectedLineIds.length === 1 ? 'line selected' : 'lines selected'}`
                : 'No selectable lines'}
            </strong>
          </div>
          {review.selectedLineIds.length > 0 ? (
            <button type="button" onClick={review.clearSelectedLines}>
              Clear
            </button>
          ) : null}
        </div>
        {!hasSelectableLines ? (
          <p role="note">
            This file-level change has no code lines to select. Line questions are unavailable.
          </p>
        ) : null}
        <label>
          <span>Question</span>
          <textarea
            ref={questionInputRef}
            rows={4}
            aria-label="Question"
            disabled={!hasSelectableLines}
            value={review.questionDraft}
            placeholder="Select code, then ask what is unclear"
            onChange={(event) => review.setQuestionDraft(event.target.value)}
          />
        </label>
        <button
          type="button"
          className="review-button review-button--primary"
          disabled={
            review.isSendingQuestion ||
            !hasSelectableLines ||
            review.selectedLineIds.length === 0 ||
            !review.questionDraft.trim()
          }
          onClick={() => void review.sendQuestion()}
        >
          {review.isSendingQuestion ? 'Sending…' : 'Send question'}
        </button>
      </section>

      {activeQuestions.length > 0 ? (
        <section className="review-question-list" aria-labelledby="review-questions-title">
          <h2 id="review-questions-title">Conversation</h2>
          {activeQuestions.map((question) => {
            const answer = bundle.answers.find((candidate) => candidate.questionId === question.id);
            return (
              <article key={question.id}>
                <span
                  className={`review-question-status review-question-status--${question.status}`}
                >
                  {QUESTION_STATUS_LABELS[question.status]}
                </span>
                <p>{question.body}</p>
                {question.failureMessage ? <small>{question.failureMessage}</small> : null}
                {answer ? <blockquote>{answer.body}</blockquote> : null}
              </article>
            );
          })}
        </section>
      ) : null}

      <section className={`review-readiness${canFinish ? ' is-ready' : ''}`}>
        <p className="review-eyebrow">Readiness</p>
        <h2>{canFinish ? 'Ready to finish' : 'Review is not ready yet'}</h2>
        {canFinish ? (
          <p>Every item is covered and every question has a durable answer.</p>
        ) : (
          <ul>
            {readiness.pending > 0 ? (
              <li>
                {readiness.pending} {readiness.pending === 1 ? 'item' : 'items'} still{' '}
                {readiness.pending === 1 ? 'needs' : 'need'} review
              </li>
            ) : null}
            {readiness.stale > 0 ? (
              <li>
                {readiness.stale} stale {readiness.stale === 1 ? 'item needs' : 'items need'}{' '}
                another look
              </li>
            ) : null}
            {readiness.unanswered > 0 ? (
              <li>
                {readiness.unanswered}{' '}
                {readiness.unanswered === 1
                  ? 'question is waiting for an answer'
                  : 'questions are waiting for answers'}
              </li>
            ) : null}
            {readiness.sourceChanged ? (
              <li>Source changed — refresh to reconcile a new revision</li>
            ) : null}
            {sourceVerificationUnavailable ? (
              <li>Source freshness could not be verified — restore capture before finishing</li>
            ) : null}
          </ul>
        )}
      </section>
    </aside>
  );
}
