// src/review-row-id.ts
function reviewRowId(itemId, position) {
  if (!Number.isSafeInteger(position) || position < 0) {
    throw new Error("review row position must be a non-negative safe integer");
  }
  return `row-${encodeURIComponent(itemId)}-${position}`;
}

// src/readiness.ts
function deriveReviewReadiness(bundle, analysisFinalized = true) {
  const states = bundle.snapshot.items.map((item) => bundle.progress.items[item.id]);
  const pending = states.filter((state) => !state || state.status === "needs-review").length;
  const stale = states.filter((state) => state?.status === "stale").length;
  const unanswered = bundle.questions.filter((question) => question.status !== "answered").length;
  return {
    ready: analysisFinalized && pending === 0 && stale === 0 && unanswered === 0 && !bundle.sourceChanged,
    preparing: !analysisFinalized,
    pending,
    stale,
    unanswered,
    sourceChanged: bundle.sourceChanged
  };
}

export {
  reviewRowId,
  deriveReviewReadiness
};
//# sourceMappingURL=chunk-VDPZNTKV.js.map