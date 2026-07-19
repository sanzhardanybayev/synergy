export type ReviewCoreErrorCode =
  | 'review_not_found'
  | 'review_conflict'
  | 'review_corrupt'
  | 'review_busy'
  | 'review_internal';

/** A stable, safe error code for callers that need to map storage failures. */
export class ReviewCoreError extends Error {
  constructor(
    readonly code: ReviewCoreErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ReviewCoreError';
  }
}

export function isReviewCoreError(error: unknown): error is ReviewCoreError {
  return error instanceof ReviewCoreError;
}
