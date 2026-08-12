import type { ReviewRef } from '@synergy/review-core';
import type { ReactNode } from 'react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import {
  getReviewBundle,
  openReviewStream,
  patchReviewProgress,
  patchReviewWalkthrough,
  postActiveReview,
  postReviewQuestion,
} from '../api.js';
import { EMPTY_REVIEW_STATE, reviewReducer } from './review-state.js';
import type {
  InReviewRemovalTarget,
  JumpOrigin,
  ReviewClient,
  ReviewContextValue,
} from './types.js';
import { useReviewOperations } from './useReviewOperations.js';
import { useReviewStream } from './useReviewStream.js';
import {
  buildChapters,
  chapterOf,
  revealedChapterCount,
  walkthroughEnabled,
} from './walkthrough.js';

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
  patchWalkthrough: patchReviewWalkthrough,
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

  // Highest chapter index (1-based count) the user has locally visited this session. Only
  // grows; reset alongside the rest of session-local walkthrough state when the bundle
  // identity (workspace/revision) changes.
  const localFloorRef = useRef(0);
  const localFloorReferenceKeyRef = useRef(currentReferenceKey);
  useEffect(() => {
    if (localFloorReferenceKeyRef.current !== currentReferenceKey) {
      localFloorReferenceKeyRef.current = currentReferenceKey;
      localFloorRef.current = 0;
    }
  }, [currentReferenceKey]);

  // Jump navigation is session-local, view-only state: it never reaches progress.json or the
  // server. `jumpOrigin` persists until the next jump (or an explicit dismiss); `flashedRowIds`
  // is a transient ~1.2s highlight that a pending timeout clears, and that timeout is cleaned up
  // both on unmount and whenever the revision identity changes underneath it.
  const [jumpOrigin, setJumpOrigin] = useState<JumpOrigin | null>(null);
  const [flashedRowIds, setFlashedRowIds] = useState<string[]>([]);
  const flashTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearFlashTimeout = useCallback((): void => {
    if (flashTimeoutRef.current !== null) {
      clearTimeout(flashTimeoutRef.current);
      flashTimeoutRef.current = null;
    }
  }, []);
  useEffect(() => clearFlashTimeout, [clearFlashTimeout]);
  const jumpReferenceKeyRef = useRef(currentReferenceKey);
  useEffect(() => {
    if (jumpReferenceKeyRef.current !== currentReferenceKey) {
      jumpReferenceKeyRef.current = currentReferenceKey;
      clearFlashTimeout();
      setJumpOrigin(null);
      setFlashedRowIds([]);
    }
  }, [currentReferenceKey, clearFlashTimeout]);

  const insights = state.bundle?.insights;
  const items = state.bundle?.snapshot.items;
  const chapters = useMemo(
    () => (insights && items ? buildChapters(insights, items) : []),
    [insights, items],
  );
  const walkthroughEnabledForBundle = insights ? walkthroughEnabled(insights) : false;
  const activeReviewItemId = state.bundle?.progress.activeReviewItemId;
  const revealedCount = state.walkthroughRevealAll
    ? chapters.length
    : Math.max(revealedChapterCount(chapters, activeReviewItemId), localFloorRef.current);

  const advanceTo = useCallback(
    (reviewItemId: string): void => {
      operations.setActiveItem(reviewItemId);
      const chapter = chapterOf(chapters, reviewItemId);
      if (!chapter) return;
      if (chapter.index + 1 > localFloorRef.current) localFloorRef.current = chapter.index + 1;
      const item = chapter.items.find((candidate) => candidate.id === reviewItemId);
      operations.advanceWalkthrough({
        activeGroupId: chapter.group.id,
        activeReviewItemId: reviewItemId,
        ...(item ? { activeFile: item.path } : {}),
      });
    },
    [chapters, operations],
  );
  const setRevealAll = useCallback((): void => {
    dispatch({ type: 'walkthrough-reveal-all' });
  }, []);

  const jumpTo = useCallback(
    (target: InReviewRemovalTarget, origin: JumpOrigin): void => {
      // advanceTo only moves the active item / walkthrough cursor - it never touches progress,
      // so a jump can never mark anything reviewed.
      advanceTo(target.reviewItemId);
      setJumpOrigin(origin);
      setFlashedRowIds(target.rowIds);
      clearFlashTimeout();
      flashTimeoutRef.current = setTimeout(() => {
        flashTimeoutRef.current = null;
        setFlashedRowIds([]);
      }, 1200);
    },
    [advanceTo, clearFlashTimeout],
  );
  const clearJumpOrigin = useCallback((): void => setJumpOrigin(null), []);

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
      walkthrough: {
        enabled: walkthroughEnabledForBundle,
        chapters,
        revealedCount,
        revealAll: state.walkthroughRevealAll,
        advanceTo,
        setRevealAll,
      },
      jump: {
        origin: jumpOrigin,
        flashedRowIds,
        jumpTo,
        clearOrigin: clearJumpOrigin,
      },
      ...operations,
    }),
    [
      advanceTo,
      chapters,
      clearJumpOrigin,
      flashedRowIds,
      jumpOrigin,
      jumpTo,
      operations,
      questionDraft,
      revealedCount,
      selectedLineIds,
      setRevealAll,
      state,
      walkthroughEnabledForBundle,
    ],
  );
  return <ReviewContext.Provider value={value}>{children}</ReviewContext.Provider>;
}

export function useReview(): ReviewContextValue {
  const value = useContext(ReviewContext);
  if (!value) throw new Error('useReview must be used within a ReviewProvider');
  return value;
}
