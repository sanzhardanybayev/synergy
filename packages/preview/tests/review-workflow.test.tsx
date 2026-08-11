import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ReviewBundle,
  type ReviewRef,
  type ReviewSnapshot,
  applyCodeSections,
  buildScopeSnapshot,
  createQuestionQueue,
  createReviewStore,
  resolveReviewItemContext,
} from '@synergy/review-core';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getReviewBundle,
  patchReviewProgress,
  patchReviewWalkthrough,
  postActiveReview,
  postReviewQuestion,
} from '../src/api.js';
import { type ReviewClient, ReviewProvider } from '../src/review/ReviewProvider.js';
import { ReviewShell } from '../src/review/ReviewShell.js';
import { handleReviewApi } from '../src/server/review-api.js';
import {
  type ReviewStreamEnvironment,
  type ReviewStreamWatcher,
  handleReviewStream,
} from '../src/server/review-stream.js';
import { codeLineText } from './review-ui-fixtures.js';
import { makeMockReq, makeMockRes } from './server/helpers.js';

const temporaryRoots = new Set<string>();
// This persisted HTTP/UI/SSE integration can exceed Vitest's 5s default under aggregate worker load.
const REVIEW_WORKFLOW_TIMEOUT_MS = 15_000;

function createPersistedScopeReview(): {
  root: string;
  reference: ReviewRef;
  bundle: ReviewBundle;
} {
  const root = mkdtempSync(join(tmpdir(), 'synergy-preview-workflow-'));
  temporaryRoots.add(root);
  const reference = { workspaceId: 'foody-scope-subscriptions', revisionId: 'rev-scope-ui' };
  const source = {
    kind: 'scope' as const,
    patterns: ['features/subscriptions'],
    headSha: 'head-scope',
  };
  const captured = buildScopeSnapshot({
    revisionId: reference.revisionId,
    source,
    fingerprint: 'scope-ui-fingerprint',
    createdAt: '2026-07-19T10:00:00.000Z',
    files: [
      {
        path: 'features/subscriptions/useSubscription.ts',
        binary: false,
        lines: [
          { number: 1, text: 'export function useSubscription() {' },
          { number: 2, text: '  return { active: true };' },
          { number: 3, text: '}' },
          { number: 4, text: 'export const subscriptionVersion = 2;' },
        ],
      },
    ],
  });
  const snapshot = applyCodeSections(captured, [
    {
      path: 'features/subscriptions/useSubscription.ts',
      label: 'useSubscription',
      start: 1,
      end: 3,
    },
  ]);
  const item = snapshot.items[0];
  if (!item) throw new Error('scope fixture must create a review item');
  const bundle: ReviewBundle = {
    workspace: {
      schemaVersion: 1,
      id: reference.workspaceId,
      repository: { root, name: 'foody' },
      source,
      currentRevisionId: reference.revisionId,
      createdAt: '2026-07-19T10:00:00.000Z',
      updatedAt: '2026-07-19T10:00:00.000Z',
    },
    snapshot,
    insights: {
      schemaVersion: 1,
      revisionId: reference.revisionId,
      groups: [{ id: 'subscriptions', label: 'Subscription access', reviewItemIds: [item.id] }],
      items: [
        {
          reviewItemId: item.id,
          description: 'Loads the persisted entitlement state for subscription-gated screens.',
          confidence: 'high',
          evidencePaths: [item.path],
        },
      ],
    },
    progress: {
      schemaVersion: 1,
      updatedAt: '2026-07-19T10:00:00.000Z',
      items: { [item.id]: { status: 'needs-review' } },
    },
    questions: [],
    answers: [],
    sourceChanged: false,
  };
  const store = createReviewStore(root);
  store.createRevision(
    bundle.workspace,
    bundle.snapshot,
    { ...bundle.insights, groups: [], items: [] },
    bundle.progress,
  );
  store.writeInitialInsights(reference.workspaceId, reference.revisionId, bundle.insights);
  return { root, reference, bundle };
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.pathname : new URL(input.url).pathname;
}

function createHandlerFetch(
  projectRoot: string,
  onFreshnessComparison?: (snapshot: Pick<ReviewSnapshot, 'source' | 'fingerprint'>) => void,
): typeof fetch {
  return async (input, init) => {
    let body: unknown;
    if (typeof init?.body === 'string') body = JSON.parse(init.body);
    const req = makeMockReq({
      method: init?.method ?? 'GET',
      url: requestUrl(input),
      body,
    });
    const { res, result } = makeMockRes();
    await handleReviewApi(
      req as unknown as IncomingMessage,
      res as unknown as ServerResponse,
      projectRoot,
      undefined,
      {
        compareSourceFreshness: (snapshot) => {
          onFreshnessComparison?.(snapshot);
          return { sourceChanged: false, captureFailed: false };
        },
      },
    );
    const response = result();
    return new Response(response.body, {
      status: response.statusCode,
      headers: Object.fromEntries(
        Object.entries(response.headers).map(([key, value]) => [key, String(value)]),
      ),
    });
  };
}

function createHandlerClient(): ReviewClient {
  return {
    getBundle: getReviewBundle,
    patchProgress: patchReviewProgress,
    postQuestion: postReviewQuestion,
    postActive: postActiveReview,
    patchWalkthrough: patchReviewWalkthrough,
    openStream: (_reference, handlers) => {
      handlers.onOpen?.();
      return { close: () => undefined };
    },
  };
}

class PassiveStreamEnvironment implements ReviewStreamEnvironment {
  watch(): ReviewStreamWatcher {
    return { close: () => undefined };
  }

  setTimeout(callback: () => void, delay: number): ReturnType<typeof setTimeout> {
    return setTimeout(callback, delay);
  }

  clearTimeout(timer: ReturnType<typeof setTimeout>): void {
    clearTimeout(timer);
  }

  setInterval(callback: () => void, delay: number): ReturnType<typeof setInterval> {
    return setInterval(callback, delay);
  }

  clearInterval(timer: ReturnType<typeof setInterval>): void {
    clearInterval(timer);
  }

  compareSourceFreshnessAsync = async () => ({ sourceChanged: false, captureFailed: false });
}

function streamRequest(reference: ReviewRef): EventEmitter & { method: string; url: string } {
  return Object.assign(new EventEmitter(), {
    method: 'GET',
    url: `/api/reviews/${reference.workspaceId}/${reference.revisionId}/stream`,
  });
}

function streamResponse(): {
  response: EventEmitter & {
    writableEnded: boolean;
    destroyed: boolean;
    writeHead(status: number, headers: Record<string, string>): void;
    write(chunk: string): boolean;
    end(): void;
  };
  chunks: string[];
} {
  const chunks: string[] = [];
  const response = Object.assign(new EventEmitter(), {
    writableEnded: false,
    destroyed: false,
    writeHead: (_status: number, _headers: Record<string, string>) => undefined,
    write: (chunk: string) => {
      chunks.push(chunk);
      return true;
    },
    end: () => {
      response.writableEnded = true;
    },
  });
  return { response, chunks };
}

function streamedAnswerBodies(chunks: string[]): string[] {
  const bodies: string[] = [];
  for (const block of chunks.join('').split('\n\n')) {
    const data = block
      .split('\n')
      .find((line) => line.startsWith('data: '))
      ?.slice('data: '.length);
    if (!data) continue;
    const frame: unknown = JSON.parse(data);
    if (
      typeof frame !== 'object' ||
      frame === null ||
      !('type' in frame) ||
      frame.type !== 'answer'
    ) {
      continue;
    }
    if (!('answer' in frame) || typeof frame.answer !== 'object' || frame.answer === null) continue;
    if ('body' in frame.answer && typeof frame.answer.body === 'string') {
      bodies.push(frame.answer.body);
    }
  }
  return bodies;
}

afterEach(() => {
  vi.unstubAllGlobals();
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
  temporaryRoots.clear();
});

describe('persisted review UI workflow', () => {
  it('loads an exact finalized revision after its workspace advances without moving the pointer', async () => {
    const { root, reference, bundle } = createPersistedScopeReview();
    const store = createReviewStore(root);
    const successorRevisionId = 'rev-scope-ui-next';
    const successorSource = {
      kind: 'scope' as const,
      patterns: ['features/subscriptions'],
      headSha: 'head-scope-next',
    };
    store.createRevision(
      {
        ...bundle.workspace,
        source: successorSource,
        currentRevisionId: successorRevisionId,
        updatedAt: '2026-07-19T10:01:00.000Z',
      },
      {
        ...bundle.snapshot,
        revisionId: successorRevisionId,
        predecessorRevisionId: reference.revisionId,
        source: successorSource,
        fingerprint: 'scope-ui-fingerprint-next',
        createdAt: '2026-07-19T10:01:00.000Z',
      },
      { ...bundle.insights, revisionId: successorRevisionId },
      { ...bundle.progress, updatedAt: '2026-07-19T10:01:00.000Z' },
    );
    const currentWorkspace = store.readWorkspace(reference.workspaceId);
    const comparedSnapshots: Array<Pick<ReviewSnapshot, 'source' | 'fingerprint'>> = [];
    vi.stubGlobal(
      'fetch',
      createHandlerFetch(root, (snapshot) => {
        comparedSnapshots.push({ source: snapshot.source, fingerprint: snapshot.fingerprint });
      }),
    );

    const historical = await getReviewBundle(reference);

    expect(historical.bundle.workspace).toMatchObject({
      source: bundle.snapshot.source,
      currentRevisionId: reference.revisionId,
    });
    expect(historical.bundle.snapshot).toEqual(bundle.snapshot);
    expect(comparedSnapshots).toEqual([
      { source: bundle.snapshot.source, fingerprint: bundle.snapshot.fingerprint },
    ]);
    expect(store.readWorkspace(reference.workspaceId)).toEqual(currentWorkspace);
    expect(currentWorkspace).toMatchObject({
      source: successorSource,
      currentRevisionId: successorRevisionId,
    });
  });

  it(
    'reviews scoped source, queues an exact-line question, and replays its durable answer',
    async () => {
      const user = userEvent.setup();
      const { root, reference, bundle } = createPersistedScopeReview();
      vi.stubGlobal('fetch', createHandlerFetch(root));
      const client = createHandlerClient();
      render(
        <ReviewProvider reference={reference} client={client}>
          <ReviewShell />
        </ReviewProvider>,
      );

      expect(await screen.findByText('Subscription access')).toBeVisible();
      expect(screen.getByText(codeLineText('export const subscriptionVersion = 2;'))).toBeVisible();
      expect(screen.queryByText('ignored dependency output')).not.toBeInTheDocument();
      expect(bundle.snapshot.files.map((file) => file.path)).toEqual([
        'features/subscriptions/useSubscription.ts',
      ]);

      await user.click(screen.getByRole('button', { name: 'Select source line 2' }));
      await user.type(
        screen.getByRole('textbox', { name: 'Question' }),
        'Why is the active entitlement returned here?',
      );
      await user.click(screen.getByRole('button', { name: 'Send question' }));
      expect(await screen.findByText('Question queued')).toBeVisible();
      await user.click(screen.getByRole('button', { name: 'Mark reviewed' }));
      expect(await screen.findByText('1 question is waiting for an answer')).toBeVisible();

      const store = createReviewStore(root);
      const persisted = store.readBundle(reference.workspaceId, reference.revisionId);
      const question = persisted.questions[0];
      const item = persisted.snapshot.items[0];
      if (!question || !item) throw new Error('UI did not persist the review question');
      const canonicalRows = resolveReviewItemContext(persisted.snapshot, item.id).rows;
      const selectedRow = canonicalRows[1];
      if (!selectedRow) throw new Error('scope fixture must expose the selected source row');
      expect(question.selection.selectedLineIds).toEqual([selectedRow.id]);
      expect(persisted.progress.items[item.id]?.status).toBe('reviewed');

      const queue = createQuestionQueue(root, reference);
      const now = Date.now();
      const claim = queue.claim(question.id, 'agent-fresh', now, 60_000);
      if (!claim.ok || !claim.question?.claim) throw new Error('fresh agent could not claim');
      const answer = queue.answer(
        question.id,
        'agent-fresh',
        claim.question.claim.token,
        'The hook exposes the durable entitlement consumed by gated screens.',
        now + 1,
      );

      const request = streamRequest(reference);
      const { response, chunks } = streamResponse();
      await handleReviewStream(
        request as unknown as IncomingMessage,
        response as unknown as ServerResponse,
        root,
        reference,
        new PassiveStreamEnvironment(),
      );
      expect(streamedAnswerBodies(chunks)).toContain(answer.body);
      request.emit('close');
      await waitFor(() => expect(response.writableEnded).toBe(true));
    },
    REVIEW_WORKFLOW_TIMEOUT_MS,
  );
});
