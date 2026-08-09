import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  type ReviewBundle,
  type ReviewItem,
  type ReviewQuestionInput,
  type WalkthroughPosition,
  compareReviewSourceFreshness,
  createQuestionQueue,
  createReviewStore,
  deriveReviewReadiness,
  isReviewCoreError,
  resolveReviewItemContext,
  resolveReviewLineSelection,
} from '@synergy/review-core';
import { sendJson } from './http.js';
import { type ReviewRoute, matchReviewRoute } from './review-router.js';

const MAX_BODY_BYTES = 64 * 1024;
const MAX_NOTE_LENGTH = 4_000;
const MAX_QUESTION_LENGTH = 12_000;

export interface ReviewApiOptions {
  compareSourceFreshness?: typeof compareReviewSourceFreshness;
}

class ReviewApiError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 413 | 415 | 422 | 423 | 500,
    readonly code: string,
  ) {
    super(code);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).some((key) => !keys.includes(key))) {
    throw new ReviewApiError(400, 'invalid_request');
  }
}

async function readReviewJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new ReviewApiError(413, 'body_too_large'));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new ReviewApiError(400, 'invalid_json'));
      }
    });
    req.on('error', () => reject(new ReviewApiError(400, 'invalid_request')));
  });
}

function assertJsonContentType(req: IncomingMessage): void {
  const contentType = req.headers['content-type'];
  if (
    typeof contentType !== 'string' ||
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(contentType.trim())
  ) {
    throw new ReviewApiError(415, 'unsupported_media_type');
  }
}

function getItem(bundle: ReviewBundle, reviewItemId: string): ReviewItem {
  const item = bundle.snapshot.items.find((candidate) => candidate.id === reviewItemId);
  if (!item) throw new ReviewApiError(400, 'unknown_review_item');
  return item;
}

function reviewError(error: unknown): ReviewApiError {
  if (error instanceof ReviewApiError) return error;
  if (isReviewCoreError(error)) {
    const status =
      error.code === 'review_not_found'
        ? 404
        : error.code === 'review_conflict'
          ? 409
          : error.code === 'review_corrupt'
            ? 422
            : error.code === 'review_busy'
              ? 423
              : 500;
    return new ReviewApiError(status, error.code);
  }
  return new ReviewApiError(500, 'internal_error');
}

function bundleResponse({
  bundle,
  analysisFinalized,
}: {
  bundle: ReviewBundle;
  analysisFinalized: boolean;
}) {
  return {
    bundle,
    readiness: deriveReviewReadiness(bundle, analysisFinalized),
    analysisFinalized,
  };
}

function readFreshBundle(
  projectRoot: string,
  workspaceId: string,
  revisionId: string,
  options: ReviewApiOptions,
): { bundle: ReviewBundle; analysisFinalized: boolean } {
  const store = createReviewStore(projectRoot);
  // The finalized marker is published after the atomic bundle replacement. Reading it first
  // prevents pairing a pending bundle with a finalized marker during that transition.
  const analysisFinalized = store.isAnalysisFinalized(workspaceId, revisionId);
  const bundle = store.readBundle(workspaceId, revisionId);
  const freshness = (options.compareSourceFreshness ?? compareReviewSourceFreshness)(
    bundle.snapshot,
    projectRoot,
  );
  return {
    bundle: { ...bundle, sourceChanged: freshness.sourceChanged },
    analysisFinalized,
  };
}

type ProgressPatch =
  | {
      kind: 'item';
      reviewItemId: string;
      patch: { status?: 'reviewed' | 'needs-review'; note?: string | null };
    }
  | { kind: 'walkthrough'; position: WalkthroughPosition };

function parseProgress(value: unknown, bundle: ReviewBundle): ProgressPatch {
  if (!isRecord(value)) throw new ReviewApiError(400, 'invalid_request');

  if ('walkthrough' in value) {
    assertOnlyKeys(value, ['walkthrough']);
    const cursor = value.walkthrough;
    if (!isRecord(cursor)) throw new ReviewApiError(400, 'invalid_request');
    assertOnlyKeys(cursor, ['activeGroupId', 'activeReviewItemId', 'activeFile']);
    if (typeof cursor.activeGroupId !== 'string' || typeof cursor.activeReviewItemId !== 'string') {
      throw new ReviewApiError(400, 'invalid_request');
    }
    if (cursor.activeFile !== undefined && typeof cursor.activeFile !== 'string') {
      throw new ReviewApiError(400, 'invalid_request');
    }
    const group = bundle.insights.groups.find((candidate) => candidate.id === cursor.activeGroupId);
    if (!group) {
      throw new ReviewApiError(400, 'invalid_walkthrough_position');
    }
    getItem(bundle, cursor.activeReviewItemId);
    if (!group.reviewItemIds.includes(cursor.activeReviewItemId)) {
      throw new ReviewApiError(400, 'invalid_walkthrough_position');
    }
    return {
      kind: 'walkthrough',
      position: {
        activeGroupId: cursor.activeGroupId,
        activeReviewItemId: cursor.activeReviewItemId,
        ...(cursor.activeFile === undefined ? {} : { activeFile: cursor.activeFile }),
      },
    };
  }

  assertOnlyKeys(value, ['reviewItemId', 'status', 'note']);
  if (typeof value.reviewItemId !== 'string') throw new ReviewApiError(400, 'invalid_request');
  getItem(bundle, value.reviewItemId);
  if (
    value.status !== undefined &&
    value.status !== 'reviewed' &&
    value.status !== 'needs-review'
  ) {
    throw new ReviewApiError(400, 'invalid_progress_status');
  }
  if (
    value.note !== undefined &&
    value.note !== null &&
    (typeof value.note !== 'string' || value.note.length > MAX_NOTE_LENGTH)
  ) {
    throw new ReviewApiError(400, 'invalid_note');
  }
  if (value.status === undefined && value.note === undefined) {
    throw new ReviewApiError(400, 'empty_progress_patch');
  }
  return {
    kind: 'item',
    reviewItemId: value.reviewItemId,
    patch: {
      ...(value.status === undefined ? {} : { status: value.status }),
      ...(value.note === undefined ? {} : { note: value.note }),
    },
  };
}

function parseLineIds(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((line) => typeof line !== 'string' || line.length === 0)
  ) {
    throw new ReviewApiError(400, 'invalid_selected_lines');
  }
  if (new Set(value).size !== value.length) {
    throw new ReviewApiError(400, 'invalid_selected_lines');
  }
  return value;
}

function parseQuestion(value: unknown, bundle: ReviewBundle): ReviewQuestionInput {
  if (!isRecord(value)) throw new ReviewApiError(400, 'invalid_request');
  assertOnlyKeys(value, ['reviewItemId', 'selectedLineIds', 'body']);
  if (typeof value.reviewItemId !== 'string' || typeof value.body !== 'string') {
    throw new ReviewApiError(400, 'invalid_request');
  }
  if (value.body.trim().length === 0 || value.body.length > MAX_QUESTION_LENGTH) {
    throw new ReviewApiError(400, 'invalid_question_body');
  }
  const item = getItem(bundle, value.reviewItemId);
  const selectedLineIds = parseLineIds(value.selectedLineIds);
  let selection: ReviewQuestionInput['selection'];
  let itemContext: ReviewQuestionInput['itemContext'];
  try {
    selection = resolveReviewLineSelection(bundle.snapshot, item.id, selectedLineIds);
    itemContext = resolveReviewItemContext(bundle.snapshot, item.id);
  } catch {
    throw new ReviewApiError(400, 'invalid_source_selection');
  }
  const insight = bundle.insights.items.find((candidate) => candidate.reviewItemId === item.id);
  return {
    id: `question-${randomUUID()}`,
    path: item.path,
    reviewItemId: item.id,
    selection,
    itemContext,
    description: insight?.description ?? '',
    body: value.body.trim(),
    createdAt: new Date().toISOString(),
  };
}

function parseActive(value: unknown): void {
  if (!isRecord(value)) throw new ReviewApiError(400, 'invalid_request');
  assertOnlyKeys(value, []);
}

function methodFor(route: ReviewRoute): string {
  return route.kind === 'bundle' ? 'GET' : route.kind === 'progress' ? 'PATCH' : 'POST';
}

/** Handles non-streaming review requests after their route has been validated. */
export async function handleReviewApi(
  req: IncomingMessage,
  res: ServerResponse,
  projectRoot: string,
  suppliedRoute?: ReviewRoute,
  options: ReviewApiOptions = {},
): Promise<void> {
  const route =
    suppliedRoute ?? matchReviewRoute(new URL(req.url ?? '/', 'http://localhost').pathname);
  if (!route || route.kind === 'stream' || route.kind === 'index') {
    sendJson(res, 404, { error: 'review_route_not_found' });
    return;
  }
  if (req.method !== methodFor(route)) {
    sendJson(res, 405, { error: 'method_not_allowed' });
    return;
  }

  try {
    const store = createReviewStore(projectRoot);
    if (route.kind === 'bundle') {
      sendJson(
        res,
        200,
        bundleResponse(
          readFreshBundle(
            projectRoot,
            route.reference.workspaceId,
            route.reference.revisionId,
            options,
          ),
        ),
      );
      return;
    }

    assertJsonContentType(req);
    const body = await readReviewJson(req);
    const bundle = store.readBundle(route.reference.workspaceId, route.reference.revisionId);
    if (route.kind === 'progress') {
      const update = parseProgress(body, bundle);
      if (update.kind === 'walkthrough') {
        store.patchWalkthroughPosition(
          route.reference.workspaceId,
          route.reference.revisionId,
          update.position,
        );
      } else {
        store.patchItemProgress(
          route.reference.workspaceId,
          route.reference.revisionId,
          update.reviewItemId,
          update.patch,
        );
      }
      sendJson(
        res,
        200,
        bundleResponse(
          readFreshBundle(
            projectRoot,
            route.reference.workspaceId,
            route.reference.revisionId,
            options,
          ),
        ),
      );
      return;
    }
    if (route.kind === 'questions') {
      const question = createQuestionQueue(projectRoot, route.reference).enqueue(
        parseQuestion(body, bundle),
      );
      sendJson(res, 201, {
        question,
        ...bundleResponse(
          readFreshBundle(
            projectRoot,
            route.reference.workspaceId,
            route.reference.revisionId,
            options,
          ),
        ),
      });
      return;
    }

    parseActive(body);
    sendJson(res, 200, {
      pointer: store.setActiveReview(route.reference.workspaceId, route.reference.revisionId),
    });
  } catch (error) {
    const mapped = reviewError(error);
    sendJson(res, mapped.status, { error: mapped.code });
  }
}
