import type { ReviewBundle, ReviewReadiness } from './types.js';

/** Calculates readiness solely from the current snapshot, review progress, questions, and freshness. */
export function deriveReviewReadiness(
  bundle: ReviewBundle,
  analysisFinalized = true,
): ReviewReadiness {
  const states = bundle.snapshot.items.map((item) => bundle.progress.items[item.id]);
  const pending = states.filter((state) => !state || state.status === 'needs-review').length;
  const stale = states.filter((state) => state?.status === 'stale').length;
  const unanswered = bundle.questions.filter((question) => question.status !== 'answered').length;

  return {
    ready:
      analysisFinalized &&
      pending === 0 &&
      stale === 0 &&
      unanswered === 0 &&
      !bundle.sourceChanged,
    preparing: !analysisFinalized,
    pending,
    stale,
    unanswered,
    sourceChanged: bundle.sourceChanged,
  };
}
