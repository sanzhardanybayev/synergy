import { L as ReviewSnapshot, n as ReviewItemContext } from './readiness-BzMn-eIV.js';
export { T as deriveReviewReadiness } from './readiness-BzMn-eIV.js';

/** Serializes review records with sorted object keys while preserving array order. */
declare function stableReviewJson(value: unknown): string;
/** Browser-safe canonical row contexts for immutable review items. */
declare function resolveBrowserReviewItemContext(snapshot: ReviewSnapshot, reviewItemId: string): ReviewItemContext;

export { resolveBrowserReviewItemContext, stableReviewJson };
