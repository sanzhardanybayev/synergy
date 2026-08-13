import { X as ReviewSnapshot, x as ReviewItemContext } from './removals-CpjQNzVH.js';
export { i as RemovalRun, k as RemovalStrip, m as ResolvedRemovalTarget, a3 as buildRemovalStrips, a4 as deriveRemovalRuns, a5 as deriveReviewReadiness } from './removals-CpjQNzVH.js';

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
