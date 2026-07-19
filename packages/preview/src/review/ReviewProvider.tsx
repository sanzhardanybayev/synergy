import type { ReviewRef } from '@synergy/review-core';
import type { ReactNode } from 'react';
import { createContext, useContext, useMemo, useReducer } from 'react';
import {
  getReviewBundle,
  openReviewStream,
  patchReviewProgress,
  postActiveReview,
  postReviewQuestion,
} from '../api.js';
import { EMPTY_REVIEW_STATE, reviewReducer } from './review-state.js';
import type { ReviewClient, ReviewContextValue } from './types.js';
import { useReviewOperations } from './useReviewOperations.js';
import { useReviewStream } from './useReviewStream.js';

export type { ReviewClient, ReviewContextValue } from './types.js';
export type { ReviewStreamHandlers } from '../api.js';

interface ReviewProviderProps {
  reference: ReviewRef;
  children: ReactNode;
  client?: ReviewClient;
}

const DEFAULT_CLIENT: ReviewClient = {
  getBundle: getReviewBundle,
  patchProgress: patchReviewProgress,
  postQuestion: postReviewQuestion,
  postActive: postActiveReview,
  openStream: openReviewStream,
};

const ReviewContext = createContext<ReviewContextValue | null>(null);

function referenceKey(reference: ReviewRef): string {
  return `${reference.workspaceId}\u0000${reference.revisionId}`;
}

/** Provides durable review state; reducers retain drafts while operation and stream hooks own I/O. */
export function ReviewProvider({
  reference,
  children,
  client = DEFAULT_CLIENT,
}: ReviewProviderProps) {
  const [state, dispatch] = useReducer(reviewReducer, EMPTY_REVIEW_STATE);
  const currentReferenceKey = referenceKey(reference);
  const stableReference = useMemo<ReviewRef>(
    () => ({ workspaceId: reference.workspaceId, revisionId: reference.revisionId }),
    [reference.revisionId, reference.workspaceId],
  );
  const operations = useReviewOperations({
    client,
    reference: stableReference,
    referenceKey: currentReferenceKey,
    state,
    dispatch,
  });
  useReviewStream({
    client,
    reference: stableReference,
    enabled: state.status === 'ready',
    analysisFinalized: state.analysisFinalized,
    dispatch,
  });

  const selectedLineIds = state.activeItemId ? (state.selections[state.activeItemId] ?? []) : [];
  const questionDraft = state.activeItemId ? (state.questionDrafts[state.activeItemId] ?? '') : '';
  const value = useMemo<ReviewContextValue>(
    () => ({
      status: state.status,
      error: state.error,
      bundle: state.bundle,
      readiness: state.readiness,
      analysisFinalized: state.analysisFinalized,
      activeItemId: state.activeItemId,
      selectedLineIds,
      noteDrafts: state.noteDrafts,
      questionDraft,
      savingItemIds: state.savingItemIds,
      isSendingQuestion: state.isSendingQuestion,
      isListening: state.isListening,
      streamStatus: state.streamStatus,
      interruptionCode: state.interruptionCode,
      sourceChanged: state.bundle?.sourceChanged ?? false,
      captureFailed: state.captureFailed,
      ...operations,
    }),
    [operations, questionDraft, selectedLineIds, state],
  );
  return <ReviewContext.Provider value={value}>{children}</ReviewContext.Provider>;
}

export function useReview(): ReviewContextValue {
  const value = useContext(ReviewContext);
  if (!value) throw new Error('useReview must be used within a ReviewProvider');
  return value;
}
