import type { ReviewRef, WalkthroughPosition } from '@synergy/review-core';
import { resolveBrowserReviewItemContext } from '@synergy/review-core/browser';
import { useCallback, useEffect, useRef } from 'react';
import type { Dispatch } from 'react';
import type { ReviewAction, ReviewState } from './review-state.js';
import type { ReviewClient } from './types.js';

interface UseReviewOperationsOptions {
  client: ReviewClient;
  reference: ReviewRef;
  referenceKey: string;
  state: ReviewState;
  dispatch: Dispatch<ReviewAction>;
}

export interface ReviewOperations {
  retry(): Promise<void>;
  setActiveItem(reviewItemId: string): void;
  toggleSelectedLine(lineId: string): void;
  clearSelectedLines(): void;
  setNoteDraft(reviewItemId: string, value: string): void;
  saveNote(reviewItemId: string): Promise<void>;
  markProgress(reviewItemId: string, status: 'reviewed' | 'needs-review'): Promise<void>;
  setQuestionDraft(value: string): void;
  sendQuestion(): Promise<void>;
  advanceWalkthrough(position: WalkthroughPosition): void;
}

function errorMessage(prefix: string, error: unknown): string {
  return `${prefix}: ${error instanceof Error && error.message ? error.message : 'request_failed'}`;
}

/** Owns abortable HTTP work and only merges durable responses still current for this reference. */
export function useReviewOperations({
  client,
  reference,
  referenceKey,
  state,
  dispatch,
}: UseReviewOperationsOptions): ReviewOperations {
  const requestReference = reference;
  const referenceKeyRef = useRef(referenceKey);
  const epochRef = useRef(0);
  const mountedRef = useRef(true);
  const pendingItemTokensRef = useRef(new Set<string>());
  const sendingTokenRef = useRef<string | null>(null);
  const activeControllersRef = useRef(new Set<AbortController>());
  const track = useCallback((controller: AbortController): AbortSignal => {
    activeControllersRef.current.add(controller);
    return controller.signal;
  }, []);
  const release = useCallback((controller: AbortController): void => {
    activeControllersRef.current.delete(controller);
  }, []);

  useEffect(() => {
    referenceKeyRef.current = referenceKey;
    epochRef.current += 1;
    pendingItemTokensRef.current.clear();
    sendingTokenRef.current = null;
    for (const controller of activeControllersRef.current) controller.abort();
    activeControllersRef.current.clear();
  }, [referenceKey]);
  useEffect(() => {
    mountedRef.current = true;
    epochRef.current += 1;
    return () => {
      mountedRef.current = false;
      epochRef.current += 1;
      for (const controller of activeControllersRef.current) controller.abort();
      activeControllersRef.current.clear();
    };
  }, []);

  const retry = useCallback(async (): Promise<void> => {
    const requestKey = referenceKey;
    const requestEpoch = epochRef.current;
    const controller = new AbortController();
    const signal = track(controller);
    dispatch({ type: 'loading' });
    try {
      const response = await client.getBundle(requestReference, signal);
      if (
        !mountedRef.current ||
        epochRef.current !== requestEpoch ||
        referenceKeyRef.current !== requestKey ||
        signal.aborted
      )
        return;
      dispatch({ type: 'loaded', payload: response });
      const activeController = new AbortController();
      const activeSignal = track(activeController);
      void client
        .postActive(requestReference, activeSignal)
        .catch((error: unknown) => {
          if (
            mountedRef.current &&
            epochRef.current === requestEpoch &&
            referenceKeyRef.current === requestKey &&
            !activeSignal.aborted
          ) {
            dispatch({
              type: 'set-error',
              error: errorMessage('Could not mark review active', error),
            });
          }
        })
        .finally(() => release(activeController));
    } catch (error) {
      if (
        !mountedRef.current ||
        epochRef.current !== requestEpoch ||
        referenceKeyRef.current !== requestKey ||
        signal.aborted
      )
        return;
      dispatch({ type: 'load-failed', error: errorMessage('Could not load review', error) });
    } finally {
      release(controller);
    }
  }, [client, dispatch, referenceKey, release, requestReference, track]);

  useEffect(() => {
    void retry();
  }, [retry]);

  const saveProgress = useCallback(
    async (
      reviewItemId: string,
      patch: { status?: 'reviewed' | 'needs-review'; note?: string | null },
      clearNote: boolean,
    ): Promise<void> => {
      const requestEpoch = epochRef.current;
      const lockToken = `${requestEpoch}\u0000${reviewItemId}`;
      if (pendingItemTokensRef.current.has(lockToken)) return;
      const requestKey = referenceKey;
      const controller = new AbortController();
      const signal = track(controller);
      pendingItemTokensRef.current.add(lockToken);
      dispatch({ type: 'set-saving', reviewItemId, saving: true });
      try {
        const response = await client.patchProgress(requestReference, reviewItemId, patch, signal);
        if (
          !mountedRef.current ||
          epochRef.current !== requestEpoch ||
          referenceKeyRef.current !== requestKey ||
          signal.aborted
        )
          return;
        dispatch({ type: 'loaded', payload: response });
        if (clearNote && patch.note !== undefined) {
          dispatch({
            type: 'clear-note',
            reviewItemId,
            expectedValue: patch.note ?? '',
          });
        }
      } catch (error) {
        if (
          !mountedRef.current ||
          epochRef.current !== requestEpoch ||
          referenceKeyRef.current !== requestKey ||
          signal.aborted
        )
          return;
        dispatch({
          type: 'set-error',
          error: errorMessage('Could not save review progress', error),
        });
      } finally {
        release(controller);
        if (
          mountedRef.current &&
          epochRef.current === requestEpoch &&
          referenceKeyRef.current === requestKey
        ) {
          pendingItemTokensRef.current.delete(lockToken);
          dispatch({ type: 'set-saving', reviewItemId, saving: false });
        }
      }
    },
    [client, dispatch, referenceKey, release, requestReference, track],
  );

  const setActiveItem = useCallback(
    (reviewItemId: string): void => {
      if (state.bundle?.snapshot.items.some((item) => item.id === reviewItemId)) {
        dispatch({ type: 'set-active', reviewItemId });
      }
    },
    [dispatch, state.bundle],
  );
  const toggleSelectedLine = useCallback(
    (lineId: string): void => {
      if (!state.activeItemId || !state.bundle) return;
      try {
        const valid = resolveBrowserReviewItemContext(
          state.bundle.snapshot,
          state.activeItemId,
        ).rows.some((row) => row.id === lineId);
        if (valid) {
          dispatch({ type: 'toggle-line', reviewItemId: state.activeItemId, lineId });
        } else {
          dispatch({ type: 'set-error', error: 'Selected source row is no longer available' });
        }
      } catch {
        dispatch({ type: 'set-error', error: 'This item has no selectable source rows' });
      }
    },
    [dispatch, state.activeItemId, state.bundle],
  );
  const clearSelectedLines = useCallback((): void => {
    if (state.activeItemId) dispatch({ type: 'clear-lines', reviewItemId: state.activeItemId });
  }, [dispatch, state.activeItemId]);
  const setNoteDraft = useCallback(
    (reviewItemId: string, value: string): void => {
      dispatch({ type: 'set-note', reviewItemId, value });
    },
    [dispatch],
  );
  const saveNote = useCallback(
    async (reviewItemId: string): Promise<void> => {
      const note = state.noteDrafts[reviewItemId];
      if (note !== undefined) await saveProgress(reviewItemId, { note: note || null }, true);
    },
    [saveProgress, state.noteDrafts],
  );
  const markProgress = useCallback(
    async (reviewItemId: string, status: 'reviewed' | 'needs-review'): Promise<void> =>
      saveProgress(reviewItemId, { status }, false),
    [saveProgress],
  );
  const setQuestionDraft = useCallback(
    (value: string): void => {
      if (state.activeItemId)
        dispatch({ type: 'set-question', reviewItemId: state.activeItemId, value });
    },
    [dispatch, state.activeItemId],
  );
  const sendQuestion = useCallback(async (): Promise<void> => {
    const reviewItemId = state.activeItemId;
    if (!reviewItemId) return;
    const body = state.questionDrafts[reviewItemId] ?? '';
    const selectedLineIds = state.selections[reviewItemId] ?? [];
    if (!body.trim() || selectedLineIds.length === 0) {
      dispatch({
        type: 'set-error',
        error: 'Select at least one line and enter a question before sending',
      });
      return;
    }
    const requestKey = referenceKey;
    const requestEpoch = epochRef.current;
    const sendingToken = `${requestEpoch}\u0000question`;
    if (sendingTokenRef.current === sendingToken) return;
    const controller = new AbortController();
    const signal = track(controller);
    sendingTokenRef.current = sendingToken;
    dispatch({ type: 'set-sending', sending: true });
    try {
      const response = await client.postQuestion(
        requestReference,
        reviewItemId,
        selectedLineIds,
        body,
        signal,
      );
      if (
        !mountedRef.current ||
        epochRef.current !== requestEpoch ||
        referenceKeyRef.current !== requestKey ||
        signal.aborted
      )
        return;
      dispatch({ type: 'loaded', payload: response });
      dispatch({
        type: 'clear-question',
        reviewItemId,
        expectedBody: body,
        expectedLineIds: selectedLineIds,
      });
    } catch (error) {
      if (
        !mountedRef.current ||
        epochRef.current !== requestEpoch ||
        referenceKeyRef.current !== requestKey ||
        signal.aborted
      )
        return;
      dispatch({ type: 'set-error', error: errorMessage('Could not queue question', error) });
    } finally {
      release(controller);
      if (
        mountedRef.current &&
        epochRef.current === requestEpoch &&
        referenceKeyRef.current === requestKey
      ) {
        if (sendingTokenRef.current === sendingToken) sendingTokenRef.current = null;
        dispatch({ type: 'set-sending', sending: false });
      }
    }
  }, [
    client,
    dispatch,
    referenceKey,
    release,
    requestReference,
    state.activeItemId,
    state.questionDrafts,
    state.selections,
    track,
  ]);
  const advanceWalkthrough = useCallback(
    (position: WalkthroughPosition): void => {
      const requestKey = referenceKey;
      const requestEpoch = epochRef.current;
      const controller = new AbortController();
      const signal = track(controller);
      client
        .patchWalkthrough(requestReference, position, signal)
        .then((response) => {
          if (
            !mountedRef.current ||
            epochRef.current !== requestEpoch ||
            referenceKeyRef.current !== requestKey ||
            signal.aborted
          )
            return;
          dispatch({ type: 'loaded', payload: response });
        })
        .catch((error: unknown) => {
          // Cursor persistence is a convenience; navigation must never block on it.
          console.error('Could not persist walkthrough cursor', error);
        })
        .finally(() => release(controller));
    },
    [client, dispatch, referenceKey, release, requestReference, track],
  );

  return {
    retry,
    setActiveItem,
    toggleSelectedLine,
    clearSelectedLines,
    setNoteDraft,
    saveNote,
    markProgress,
    setQuestionDraft,
    sendQuestion,
    advanceWalkthrough,
  };
}
