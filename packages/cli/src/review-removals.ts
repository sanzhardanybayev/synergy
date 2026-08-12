import {
  RELOCATING_REMOVAL_REASONS,
  type RemovalRationale,
  type ReviewSnapshot,
  deriveSnapshotRemovalRuns,
} from '@synergy/review-core';

/**
 * Not expressible in review-analysis.schema.json (a JSON Schema cannot compute `end - start`), so
 * this cap is enforced only here, semantically, by `assertCompleteRemovalCoverage` below.
 */
export const MAX_MOVED_TO_LINES = 40;

function runKey(path: string, start: number, end: number): string {
  return `${path}:${start}-${end}`;
}

export function assertCompleteRemovalCoverage(
  snapshot: ReviewSnapshot,
  removals: readonly RemovalRationale[],
): void {
  const derived = deriveSnapshotRemovalRuns(snapshot);
  if (derived.length === 0 && removals.length === 0) return;

  const derivedByKey = new Map(derived.map((run) => [runKey(run.path, run.start, run.end), run]));
  const seen = new Set<string>();

  for (const rationale of removals) {
    const key = runKey(rationale.run.path, rationale.run.start, rationale.run.end);
    const run = derivedByKey.get(key);
    if (!run) {
      throw new Error(`removal rationale ${key} does not match a captured removal run`);
    }
    if (run.reviewItemId !== rationale.reviewItemId) {
      throw new Error(
        `removal rationale ${key} names review item ${rationale.reviewItemId} but the run belongs to ${run.reviewItemId}`,
      );
    }
    if (seen.has(key)) throw new Error(`duplicate removal rationale for ${key}`);
    seen.add(key);

    const relocating = RELOCATING_REMOVAL_REASONS.includes(rationale.reason);
    if (relocating && !rationale.movedTo) {
      throw new Error(`removal rationale ${key} with reason ${rationale.reason} requires movedTo`);
    }
    if (!relocating && rationale.movedTo) {
      throw new Error(
        `removal rationale ${key} with reason ${rationale.reason} must not carry movedTo`,
      );
    }
    const target = rationale.movedTo;
    if (target) {
      if (target.start > target.end) {
        throw new Error(`removal rationale ${key} has a reversed range in movedTo`);
      }
      if (target.end - target.start + 1 > MAX_MOVED_TO_LINES) {
        throw new Error(
          `removal rationale ${key} movedTo must span at most ${MAX_MOVED_TO_LINES} lines`,
        );
      }
    }
  }

  const missing = derived
    .filter((run) => !seen.has(runKey(run.path, run.start, run.end)))
    .map((run) => runKey(run.path, run.start, run.end));
  if (missing.length > 0) {
    throw new Error(`removal runs are missing a rationale: ${missing.join(', ')}`);
  }
}
