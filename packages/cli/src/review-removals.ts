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

    // `undefined` intentionally conflates "the file does not exist at this source" with "the
    // read failed for another reason" (a git command's non-zero exit, an ENOENT) - `io`
    // deliberately has no room to distinguish them (see RemovalExcerptIo above), so a real git
    // failure surfaces with the same "not found" message a genuinely missing path would.
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

/**
 * Re-resolves each carried-forward rationale's `movedTo` destination against the NEW revision's
 * source, so a persisted `movedToExcerpt` is never stale after a `review refresh`. A rationale
 * can carry an excerpt captured against the PREDECESSOR revision's source - nothing about
 * carry-forward constrains the moved-to destination, only the removed run's own text - so this
 * must re-verify it at the seam where the new source is captured, before `status.removals[].covered`
 * can be trusted to predict finalize-time acceptance.
 *
 * Unlike `resolveRemovalExcerpts` (which rejects an entire live submission on an unreadable or
 * out-of-range target), this never throws: a carried rationale whose destination can no longer be
 * verified is silently dropped - its run reverts to uncovered and must be re-authored - because a
 * stale excerpt must never be persisted, and a refresh is not the moment to reject the revision
 * itself over an old rationale going stale. This is true by construction, not by convention: the
 * read below is wrapped in its own `try`/`catch` so that ANY read failure - not just the
 * `undefined`-returning "not found" case `RemovalExcerptIo` documents - collapses to "drop this
 * rationale," regardless of what a given `io` implementation does. The git-backed reader
 * (`runOptional`) already collapses a non-zero exit to `undefined` on its own, but the local
 * filesystem reader (`defaultReadFile`) rethrows non-ENOENT errors (`EACCES`, `EISDIR`, …) by
 * design, because `resolveRemovalExcerpts` above needs exactly that to reject a live submission.
 * Guarding here - rather than requiring every creation-time caller to remember to wrap its `io` -
 * makes this function's own "never throws" promise true for any `io`, present or future.
 */
export function reResolveCarriedRemovals(
  snapshot: ReviewSnapshot,
  removals: readonly RemovalRationale[],
  io: RemovalExcerptIo,
): RemovalRationale[] {
  const resolved: RemovalRationale[] = [];
  for (const rationale of removals) {
    const target = rationale.movedTo;
    if (!target) {
      resolved.push(rationale);
      continue;
    }
    if (resolveRemovalTarget(snapshot, rationale).kind === 'in-review') {
      // The destination now lands inside the captured review: the preview resolves it live from
      // the snapshot, so a persisted excerpt would be dead weight that can drift. Drop it rather
      // than carry it forward unused.
      resolved.push({
        reviewItemId: rationale.reviewItemId,
        run: rationale.run,
        reason: rationale.reason,
        description: rationale.description,
        movedTo: target,
      });
      continue;
    }
    let lines: string[] | undefined;
    try {
      lines = io.readTargetLines(target.path);
    } catch {
      lines = undefined;
    }
    if (!lines || target.end > lines.length) continue;
    resolved.push({
      reviewItemId: rationale.reviewItemId,
      run: rationale.run,
      reason: rationale.reason,
      description: rationale.description,
      movedTo: target,
      movedToExcerpt: {
        path: target.path,
        start: target.start,
        lines: lines.slice(target.start - 1, target.end),
      },
    });
  }
  return resolved;
}
