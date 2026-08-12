import {
  RELOCATING_REMOVAL_REASONS,
  type RemovalRationale,
  type ReviewSnapshot,
  deriveSnapshotRemovalRuns,
  resolveRemovalTarget,
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

export interface RemovalExcerptIo {
  /** Returns the target file's lines, or undefined when the path does not exist at the source. */
  readTargetLines(path: string): string[] | undefined;
}

/**
 * Resolves `movedTo` targets that land outside the captured review into a persisted
 * `movedToExcerpt`, so browser hosts (which have no git access) never need to re-read the
 * destination. Targets that resolve inside the review are left excerpt-free - the snapshot
 * already carries those lines. A target whose file cannot be read, or whose range extends past
 * the end of the file, rejects the whole payload.
 */
export function resolveRemovalExcerpts(
  snapshot: ReviewSnapshot,
  removals: readonly RemovalRationale[],
  io: RemovalExcerptIo,
): RemovalRationale[] {
  return removals.map((rationale) => {
    const target = rationale.movedTo;
    if (!target) return rationale;
    if (resolveRemovalTarget(snapshot, rationale).kind === 'in-review') return rationale;

    const lines = io.readTargetLines(target.path);
    if (!lines) {
      throw new Error(`removal rationale movedTo target was not found: ${target.path}`);
    }
    if (target.end > lines.length) {
      throw new Error(
        `removal rationale movedTo ${target.path}:${target.start}-${target.end} is out of range (file has ${lines.length} lines)`,
      );
    }
    return {
      ...rationale,
      movedToExcerpt: {
        path: target.path,
        start: target.start,
        lines: lines.slice(target.start - 1, target.end),
      },
    };
  });
}
