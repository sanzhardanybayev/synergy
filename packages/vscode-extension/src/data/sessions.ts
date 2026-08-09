import { existsSync, readdirSync } from 'node:fs';
import {
  type ReviewBundle,
  type ReviewRef,
  type ReviewSource,
  type WalkthroughPosition,
  createReviewStore,
  reviewsDir,
} from '@synergy/review-core';

/**
 * One row in the session list surfaced by the extension's sidebar. Deliberately duplicates
 * nothing from `vscode` - this module and the rest of `src/data` are plain Node code that the
 * extension host (src/host.ts, src/extension.ts) consumes.
 */
export interface SessionSummary {
  projectRoot: string;
  workspaceId: string;
  revisionId: string;
  /** Human label for the review source, e.g. "PR #317", "Staged changes". */
  subject: string;
  itemCount: number;
  reviewedCount: number;
  updatedAt: string;
  /** Present (and human-readable) only when this workspace failed to load cleanly. */
  degraded?: string;
}

function subjectLabel(source: ReviewSource): string {
  switch (source.kind) {
    case 'pr':
      return `PR #${source.number}`;
    case 'staged':
      return 'Staged changes';
    case 'unstaged':
      return 'Unstaged changes';
    case 'scope':
      return `Scope: ${source.patterns.join(', ')}`;
  }
}

/** Items are "reviewed" for summary purposes once they carry any non-pending, non-stale status. */
function reviewedItemCount(bundle: ReviewBundle): number {
  const pendingOrStale = bundle.snapshot.items.filter((item) => {
    const state = bundle.progress.items[item.id];
    return !state || state.status === 'needs-review' || state.status === 'stale';
  }).length;
  return bundle.snapshot.items.length - pendingOrStale;
}

/**
 * Enumerates workspace ids under `<projectRoot>/.synergy/reviews` directly rather than through
 * `store.listWorkspaces()`. The store's `listWorkspaces` eagerly reads and validates every
 * workspace.json in one pass, so a single corrupt entry throws and aborts the whole listing.
 * Scanning directory entries ourselves lets each workspace fail independently below.
 */
function listWorkspaceIds(projectRoot: string): string[] {
  let dir: string;
  try {
    dir = reviewsDir(projectRoot);
  } catch {
    return [];
  }
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

function degradedMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Lists review sessions across one or more project roots, newest `updatedAt` first. */
export function listSessions(projectRoots: string[]): SessionSummary[] {
  const summaries: SessionSummary[] = [];
  for (const projectRoot of projectRoots) {
    const store = createReviewStore(projectRoot);
    for (const workspaceId of listWorkspaceIds(projectRoot)) {
      try {
        const workspace = store.readWorkspace(workspaceId);
        const bundle = store.readBundle(workspaceId, workspace.currentRevisionId);
        summaries.push({
          projectRoot,
          workspaceId,
          revisionId: workspace.currentRevisionId,
          subject: subjectLabel(bundle.workspace.source),
          itemCount: bundle.snapshot.items.length,
          reviewedCount: reviewedItemCount(bundle),
          updatedAt: workspace.updatedAt,
        });
      } catch (error) {
        summaries.push({
          projectRoot,
          workspaceId,
          revisionId: '',
          subject: 'Unavailable',
          itemCount: 0,
          reviewedCount: 0,
          updatedAt: new Date(0).toISOString(),
          degraded: degradedMessage(error),
        });
      }
    }
  }
  return summaries.sort((left, right) => (left.updatedAt < right.updatedAt ? 1 : -1));
}

export function loadBundle(projectRoot: string, ref: ReviewRef): ReviewBundle {
  return createReviewStore(projectRoot).readBundle(ref.workspaceId, ref.revisionId);
}

export function setItemStatus(
  projectRoot: string,
  ref: ReviewRef,
  reviewItemId: string,
  status: 'reviewed' | 'needs-review',
): void {
  createReviewStore(projectRoot).patchItemProgress(ref.workspaceId, ref.revisionId, reviewItemId, {
    status,
  });
}

export function saveNote(
  projectRoot: string,
  ref: ReviewRef,
  reviewItemId: string,
  note: string,
): void {
  createReviewStore(projectRoot).patchItemProgress(ref.workspaceId, ref.revisionId, reviewItemId, {
    note,
  });
}

/** Moves the walkthrough cursor. Throws (uncaught, matching `setItemStatus`'s pattern) when the
 * store rejects an unknown group or an item that is not a member of it - the caller's outer
 * try/catch turns that into a `{kind:'error'}` message instead of crashing the extension host. */
export function advanceWalkthrough(
  projectRoot: string,
  ref: ReviewRef,
  position: WalkthroughPosition,
): void {
  createReviewStore(projectRoot).patchWalkthroughPosition(
    ref.workspaceId,
    ref.revisionId,
    position,
  );
}
