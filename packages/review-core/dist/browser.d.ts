import { M as ReviewSnapshot, o as ReviewItemContext } from './readiness-CHNg2V_A.js';
export { U as deriveReviewReadiness } from './readiness-CHNg2V_A.js';

/** Serializes review records with sorted object keys while preserving array order. */
declare function stableReviewJson(value: unknown): string;
/** Browser-safe canonical row contexts for immutable review items. */
declare function resolveBrowserReviewItemContext(snapshot: ReviewSnapshot, reviewItemId: string): ReviewItemContext;

export { resolveBrowserReviewItemContext, stableReviewJson };
