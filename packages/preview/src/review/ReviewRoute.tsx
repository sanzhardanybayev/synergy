import type { ReviewRef } from '@synergy/review-core';
import { useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { postActiveReview } from '../api.js';
import { ReviewProvider } from './ReviewProvider.js';
import { ReviewShell } from './ReviewShell.js';
import type { ReviewClient } from './types.js';

interface ReviewRouteProps {
  client?: ReviewClient;
}

const SAFE_SEGMENT = /^[a-z0-9][a-z0-9._-]*$/u;

/** Binds a traversal-safe review URL to the durable review provider. */
export function ReviewRoute({ client }: ReviewRouteProps) {
  const { workspaceId, revisionId } = useParams();
  const isValid =
    workspaceId !== undefined &&
    revisionId !== undefined &&
    SAFE_SEGMENT.test(workspaceId) &&
    SAFE_SEGMENT.test(revisionId);
  const reference: ReviewRef | null = isValid ? { workspaceId, revisionId } : null;

  useEffect(() => {
    if (!reference) return;
    const ping = (): void => {
      const controller = new AbortController();
      const request = client
        ? client.postActive(reference, controller.signal)
        : postActiveReview(reference, controller.signal);
      void request.catch(() => undefined);
    };
    window.addEventListener('focus', ping);
    return () => window.removeEventListener('focus', ping);
  }, [client, reference]);

  if (!reference) {
    return (
      <main className="review-route-state">
        <p className="review-eyebrow">Synergy review</p>
        <h1>Invalid review link</h1>
        <p>The workspace or revision in this address is not valid.</p>
      </main>
    );
  }

  return (
    <ReviewProvider reference={reference} client={client}>
      <ReviewShell />
    </ReviewProvider>
  );
}
