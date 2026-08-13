import { W as ReviewSnapshot, w as ReviewItemContext } from './removals-Dpv1u444.js';
export { h as RemovalRun, j as RemovalStrip, l as ResolvedRemovalTarget, a2 as buildRemovalStrips, a3 as deriveRemovalRuns, a4 as deriveReviewReadiness } from './removals-Dpv1u444.js';

/**
 * Browser-safe canonical row contexts for immutable review items.
 *
 * Lives in its own module (rather than directly in `browser.ts`) so both `browser.ts` and
 * `removals.ts` can import it without creating a cycle between them: `removals.ts` needs this
 * resolver to stay free of node-only imports (the canonical `resolveReviewItemContext` in
 * `review-lines.ts` transitively pulls in `hash.ts` -> `node:crypto` via `diff.ts`, which the
 * preview app and VS Code webview bundlers cannot resolve), and `browser.ts` re-exports both this
 * function and removal-derivation helpers from `removals.ts`.
 */
declare function resolveBrowserReviewItemContext(snapshot: ReviewSnapshot, reviewItemId: string): ReviewItemContext;

/** Serializes review records with sorted object keys while preserving array order. */
declare function stableReviewJson(value: unknown): string;

export { resolveBrowserReviewItemContext, stableReviewJson };
