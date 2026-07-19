import type { ReviewRef } from '@synergy/review-core';
import { useEffect } from 'react';
import type { Dispatch } from 'react';
import type { ReviewAction } from './review-state.js';
import type { ReviewClient } from './types.js';

interface UseReviewStreamOptions {
  client: ReviewClient;
  reference: ReviewRef;
  enabled: boolean;
  analysisFinalized: boolean;
  dispatch: Dispatch<ReviewAction>;
}

const MAX_STREAM_CONNECTIONS = 8;

/** Maintains at most one reviewed-reference stream and reconnects with bounded backoff. */
export function useReviewStream({
  client,
  reference,
  enabled,
  analysisFinalized,
  dispatch,
}: UseReviewStreamOptions): void {
  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let connection: ReturnType<ReviewClient['openStream']> | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let stableOpenTimer: ReturnType<typeof setTimeout> | undefined;
    let reconnectAttempt = 0;
    let connectionEpoch = 0;
    let frameOrder = 0;
    let finalizationReloadStarted = false;
    const finalizationController = new AbortController();
    const seenEventIds = new Set<string>();
    const closeConnection = (): void => {
      connection?.close();
      connection = undefined;
      connectionEpoch += 1;
      if (stableOpenTimer) {
        clearTimeout(stableOpenTimer);
        stableOpenTimer = undefined;
      }
    };
    const scheduleReconnect = (): void => {
      if (disposed || retryTimer || reconnectAttempt >= MAX_STREAM_CONNECTIONS - 1) return;
      retryTimer = setTimeout(
        () => {
          retryTimer = undefined;
          open();
        },
        Math.min(4_000, 250 * 2 ** reconnectAttempt),
      );
      reconnectAttempt += 1;
    };
    const open = (): void => {
      if (disposed || connection) return;
      dispatch({ type: 'stream-status', status: 'connecting' });
      const thisConnectionEpoch = ++connectionEpoch;
      connection = client.openStream(reference, {
        onOpen: () => {
          if (!disposed && thisConnectionEpoch === connectionEpoch) {
            dispatch({ type: 'stream-open' });
            stableOpenTimer = setTimeout(() => {
              if (!disposed && thisConnectionEpoch === connectionEpoch) reconnectAttempt = 0;
            }, 5_000);
          }
        },
        onError: () => {
          if (!disposed && thisConnectionEpoch === connectionEpoch) {
            closeConnection();
            dispatch({ type: 'stream-status', status: 'interrupted' });
            scheduleReconnect();
          }
        },
        onFrame: (frame, eventId) => {
          if (
            disposed ||
            thisConnectionEpoch !== connectionEpoch ||
            (eventId && seenEventIds.has(eventId))
          )
            return;
          if (eventId) {
            seenEventIds.add(eventId);
            if (seenEventIds.size > 256) {
              const oldest = seenEventIds.values().next();
              if (!oldest.done) seenEventIds.delete(oldest.value);
            }
          }
          frameOrder += 1;
          dispatch({ type: 'stream-frame', frame, order: frameOrder });
          if (
            frame.type === 'progress' &&
            frame.analysisFinalized &&
            !analysisFinalized &&
            !finalizationReloadStarted
          ) {
            finalizationReloadStarted = true;
            void client
              .getBundle(reference, finalizationController.signal)
              .then((payload) => {
                if (!disposed && !finalizationController.signal.aborted) {
                  dispatch({ type: 'loaded', payload });
                }
              })
              .catch((error: unknown) => {
                if (!disposed && !finalizationController.signal.aborted) {
                  dispatch({
                    type: 'set-error',
                    error: `Could not load finalized review: ${error instanceof Error && error.message ? error.message : 'request_failed'}`,
                  });
                }
              });
          }
        },
      });
    };
    open();
    return () => {
      disposed = true;
      finalizationController.abort();
      closeConnection();
      if (retryTimer) clearTimeout(retryTimer);
      if (stableOpenTimer) clearTimeout(stableOpenTimer);
    };
  }, [analysisFinalized, client, dispatch, enabled, reference]);
}
