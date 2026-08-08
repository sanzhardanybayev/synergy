import type { IncomingMessage, ServerResponse } from 'node:http';
import { type ReviewRef, assertSafeReviewSegment } from '@synergy/review-core';
import { sendJson } from './http.js';
import { handleReviewApi } from './review-api.js';
import { buildReviewIndex } from './review-index.js';
import { handleReviewStream } from './review-stream.js';

export type ReviewRouteKind = 'bundle' | 'progress' | 'questions' | 'active' | 'stream' | 'index';

export type ReviewRoute =
  | { kind: 'index' }
  | { kind: Exclude<ReviewRouteKind, 'index'>; reference: ReviewRef };

const ROUTE_SUFFIXES: Record<string, Exclude<ReviewRouteKind, 'index' | 'bundle'>> = Object.assign(
  Object.create(null),
  {
    progress: 'progress',
    questions: 'questions',
    active: 'active',
    stream: 'stream',
  },
);

/** Matches a complete, safe review URL without accepting path traversal. */
export function matchReviewRoute(pathname: string): ReviewRoute | undefined {
  if (pathname === '/api/reviews') return { kind: 'index' };

  const parts = pathname.split('/');
  if (parts[0] !== '' || parts[1] !== 'api' || parts[2] !== 'reviews') return undefined;
  const workspaceId = parts[3];
  const revisionId = parts[4];
  if (!workspaceId || !revisionId || (parts.length !== 5 && parts.length !== 6)) return undefined;
  const suffix = parts.length === 6 ? parts[5] : undefined;
  if (suffix !== undefined && !Object.hasOwn(ROUTE_SUFFIXES, suffix)) return undefined;

  try {
    assertSafeReviewSegment(workspaceId, 'workspace');
    assertSafeReviewSegment(revisionId, 'revision');
  } catch {
    return undefined;
  }

  return {
    kind: suffix === undefined ? 'bundle' : ROUTE_SUFFIXES[suffix]!,
    reference: { workspaceId, revisionId },
  };
}

/** Delegates the complete /api/reviews surface while keeping Vite middleware thin. */
export async function handleReviewRouter(
  req: IncomingMessage,
  res: ServerResponse,
  projectRoot: string,
): Promise<void> {
  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
  const route = matchReviewRoute(pathname);
  if (!route) {
    sendJson(res, 404, { error: 'review_route_not_found' });
    return;
  }

  if (route.kind === 'index') {
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'method_not_allowed' });
      return;
    }
    sendJson(res, 200, await buildReviewIndex(projectRoot));
    return;
  }

  if (route.kind === 'stream') {
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'method_not_allowed' });
      return;
    }
    await handleReviewStream(req, res, projectRoot, route.reference);
    return;
  }

  await handleReviewApi(req, res, projectRoot, route);
}
