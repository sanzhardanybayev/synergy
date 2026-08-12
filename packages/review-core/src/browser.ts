export { resolveBrowserReviewItemContext } from './browser-context.js';
export { deriveReviewReadiness } from './readiness.js';

/** Serializes review records with sorted object keys while preserving array order. */
export function stableReviewJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableReviewJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableReviewJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

export {
  buildRemovalStrips,
  deriveRemovalRuns,
  type RemovalRun,
  type RemovalStrip,
  type ResolvedRemovalTarget,
} from './removals.js';
