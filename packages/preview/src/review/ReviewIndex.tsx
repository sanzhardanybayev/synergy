import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { type ReviewIndexEntry, fetchReviewIndex } from '../api.js';

export interface ReviewIndexProps {
  fetchIndex?: typeof fetchReviewIndex;
}

/** Lists every review workspace under `.synergy/reviews/` so parallel sessions stay discoverable. */
export function ReviewIndex({ fetchIndex = fetchReviewIndex }: ReviewIndexProps) {
  const [reviews, setReviews] = useState<ReviewIndexEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetchIndex(controller.signal)
      .then((response) => setReviews(response.reviews))
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : 'Failed to load reviews.');
      });
    return () => controller.abort();
  }, [fetchIndex]);

  return (
    <main className="review-index">
      <header className="review-index__header">
        <p className="review-eyebrow">Synergy review</p>
        <h1>Review sessions</h1>
      </header>

      {error && <p className="review-index__error">{error}</p>}

      {reviews && reviews.length === 0 && (
        <p className="review-index__empty">No review sessions yet.</p>
      )}

      {reviews && reviews.length > 0 && (
        <ul className="review-index__list">
          {reviews.map((review) => {
            const cardBody = (
              <>
                <div className="review-index__card-heading">
                  <h2>{review.subject}</h2>
                  <div className="review-index__badges">
                    {review.degraded && (
                      <span className="review-index__badge review-index__badge--danger">
                        Unreadable
                      </span>
                    )}
                    {review.reviewedCount === review.itemCount && review.itemCount > 0 && (
                      <span className="review-index__badge review-index__badge--success">
                        Complete
                      </span>
                    )}
                    {review.openQuestions > 0 && (
                      <span className="review-index__badge">
                        {review.openQuestions} question{review.openQuestions === 1 ? '' : 's'}
                      </span>
                    )}
                  </div>
                </div>
                <progress value={review.reviewedCount} max={Math.max(review.itemCount, 1)} />
                <p className="review-index__meta">
                  {review.reviewedCount}/{review.itemCount} reviewed
                  {' · '}
                  {review.updatedAt ? new Date(review.updatedAt).toLocaleString() : 'unknown time'}
                </p>
              </>
            );
            return (
              <li key={review.workspaceId}>
                {review.degraded ? (
                  <div className="review-index__card">{cardBody}</div>
                ) : (
                  <Link
                    className="review-index__card"
                    to={`/r/${encodeURIComponent(review.workspaceId)}/${encodeURIComponent(review.revisionId)}`}
                  >
                    {cardBody}
                  </Link>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
