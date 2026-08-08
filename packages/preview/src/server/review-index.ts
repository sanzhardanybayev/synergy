import { existsSync, readdirSync } from 'node:fs';
import {
  type ReviewSource,
  type ReviewWorkspace,
  assertSafeReviewSegment,
  createReviewStore,
  reviewsDir,
} from '@synergy/review-core';

export type ReviewIndexSourceKind = 'pr' | 'staged' | 'unstaged' | 'scope' | 'unknown';

export interface ReviewIndexEntry {
  workspaceId: string;
  revisionId: string;
  subject: string;
  sourceKind: ReviewIndexSourceKind;
  itemCount: number;
  reviewedCount: number;
  openQuestions: number;
  updatedAt: string;
  degraded?: string;
}

export interface ReviewIndexResponse {
  reviews: ReviewIndexEntry[];
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

function degradedEntry(workspaceId: string, error: unknown): ReviewIndexEntry {
  return {
    workspaceId,
    revisionId: '',
    subject: workspaceId,
    sourceKind: 'unknown',
    itemCount: 0,
    reviewedCount: 0,
    openQuestions: 0,
    updatedAt: '',
    degraded: error instanceof Error ? error.message : String(error),
  };
}

function readWorkspaceIds(projectRoot: string): string[] {
  const directory = reviewsDir(projectRoot);
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .sort()
    .filter((entry) => {
      try {
        assertSafeReviewSegment(entry, 'workspace');
        return true;
      } catch {
        return false;
      }
    });
}

/**
 * Builds the review workspace index for the daemon's `GET /api/reviews` endpoint.
 *
 * `store.listWorkspaces()` reads every workspace file in one `.map()` call, so a single
 * corrupt workspace throws and aborts the whole listing. To let one corrupt workspace
 * degrade only itself, this enumerates the reviews directory directly and reads each
 * workspace (then its current bundle) inside its own try/catch.
 */
export async function buildReviewIndex(projectRoot: string): Promise<ReviewIndexResponse> {
  const store = createReviewStore(projectRoot);
  const workspaceIds = readWorkspaceIds(projectRoot);

  const reviews = workspaceIds.map((workspaceId) => {
    let workspace: ReviewWorkspace;
    try {
      workspace = store.readWorkspace(workspaceId);
    } catch (error) {
      return degradedEntry(workspaceId, error);
    }

    try {
      const bundle = store.readBundle(workspace.id, workspace.currentRevisionId);
      const items = bundle.snapshot.items;
      const reviewedCount = items.filter((item) => {
        const status = bundle.progress.items[item.id]?.status;
        return status === 'reviewed' || status === 'carried-forward';
      }).length;
      const openQuestions = bundle.questions.filter(
        (question) => question.status === 'queued' || question.status === 'processing',
      ).length;
      return {
        workspaceId: workspace.id,
        revisionId: workspace.currentRevisionId,
        subject: subjectLabel(workspace.source),
        sourceKind: workspace.source.kind,
        itemCount: items.length,
        reviewedCount,
        openQuestions,
        updatedAt: workspace.updatedAt,
      } satisfies ReviewIndexEntry;
    } catch (error) {
      return {
        workspaceId: workspace.id,
        revisionId: workspace.currentRevisionId,
        subject: subjectLabel(workspace.source),
        sourceKind: workspace.source.kind,
        itemCount: 0,
        reviewedCount: 0,
        openQuestions: 0,
        updatedAt: workspace.updatedAt,
        degraded: error instanceof Error ? error.message : String(error),
      } satisfies ReviewIndexEntry;
    }
  });

  reviews.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return { reviews };
}
