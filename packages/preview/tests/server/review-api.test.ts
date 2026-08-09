import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import {
  type ReviewBundle,
  buildDiffSnapshot,
  createReviewStore,
  resolveReviewItemContext,
} from '@synergy/review-core';
import { afterEach, describe, expect, it } from 'vitest';
import { type ReviewApiOptions, handleReviewApi } from '../../src/server/review-api.js';
import { makeMockReq, makeMockRes, makeTempDir } from './helpers.js';

const WORKSPACE = 'workspace-a';
const REVISION = 'revision-a';

function fixture(): ReviewBundle {
  const source = { kind: 'staged' as const, headSha: 'abc123' };
  return {
    workspace: {
      schemaVersion: 1,
      id: WORKSPACE,
      repository: { root: '/repository', name: 'repository' },
      source,
      currentRevisionId: REVISION,
      createdAt: '2026-07-19T10:00:00.000Z',
      updatedAt: '2026-07-19T10:00:00.000Z',
    },
    snapshot: {
      schemaVersion: 1,
      revisionId: REVISION,
      source,
      fingerprint: 'fingerprint',
      createdAt: '2026-07-19T10:00:00.000Z',
      kind: 'scope',
      files: [
        {
          path: 'src/example.ts',
          binary: false,
          lines: [
            { number: 1, text: 'export const first = true;' },
            { number: 2, text: 'export const second = true;' },
          ],
        },
      ],
      items: [
        {
          id: 'hunk-a',
          kind: 'code-section',
          path: 'src/example.ts',
          label: 'example',
          range: { start: 1, end: 2 },
          contentHash: '2ab63c7ec7a3fa6324eeda18cb555e1c49fe5b8182d96820a27d1c02138934f9',
          locationHash: 'location-hash',
        },
      ],
    },
    insights: {
      schemaVersion: 1,
      revisionId: REVISION,
      groups: [{ id: 'group-a', label: 'Example', reviewItemIds: ['hunk-a'] }],
      items: [
        {
          reviewItemId: 'hunk-a',
          description: 'Exports two constants.',
          confidence: 'high',
          evidencePaths: ['src/example.ts'],
        },
      ],
    },
    progress: {
      schemaVersion: 1,
      updatedAt: '2026-07-19T10:00:00.000Z',
      items: { 'hunk-a': { status: 'needs-review' } },
    },
    questions: [],
    answers: [],
    sourceChanged: false,
  };
}

async function callReviewApi(
  projectRoot: string,
  method: string,
  path: string,
  body?: unknown,
  options?: ReviewApiOptions,
) {
  const req = makeMockReq({ method, url: path, body });
  const { res, result } = makeMockRes();
  await handleReviewApi(
    req as unknown as IncomingMessage,
    res as unknown as ServerResponse,
    projectRoot,
    undefined,
    options,
  );
  return result();
}

describe('review API', () => {
  let temp: ReturnType<typeof makeTempDir>;

  afterEach(() => temp?.cleanup());

  function createReview(bundle: ReviewBundle = fixture()): ReturnType<typeof createReviewStore> {
    temp = makeTempDir();
    const store = createReviewStore(temp.dir);
    store.createRevision(bundle.workspace, bundle.snapshot, bundle.insights, bundle.progress);
    return store;
  }

  it('persists review progress before returning success', async () => {
    const store = createReview();
    const response = await callReviewApi(
      temp.dir,
      'PATCH',
      `/api/reviews/${WORKSPACE}/${REVISION}/progress`,
      { reviewItemId: 'hunk-a', status: 'reviewed', note: 'Checked.' },
    );

    expect(response.statusCode).toBe(200);
    expect(store.readBundle(WORKSPACE, REVISION).progress.items['hunk-a']).toMatchObject({
      status: 'reviewed',
      note: 'Checked.',
    });
  });

  it('queues a selected-line question against the exact revision', async () => {
    const bundle = fixture();
    createReview(bundle);
    const context = resolveReviewItemContext(bundle.snapshot, 'hunk-a');
    const response = await callReviewApi(
      temp.dir,
      'POST',
      `/api/reviews/${WORKSPACE}/${REVISION}/questions`,
      {
        reviewItemId: 'hunk-a',
        selectedLineIds: [context.rows[1]!.id],
        body: 'Why is this safe on Android?',
      },
    );

    expect(response.statusCode).toBe(201);
    expect((response.json as { question: { revisionId: string } }).question.revisionId).toBe(
      REVISION,
    );
    expect(response.json).toMatchObject({
      question: {
        selection: { kind: 'scope', selectedLineIds: [context.rows[1]!.id] },
        itemContext: context,
      },
    });
  });

  it('queues deletion-only and replacement selections with complete diff context', async () => {
    const base = fixture();
    const snapshot = buildDiffSnapshot({
      revisionId: REVISION,
      source: base.snapshot.source,
      fingerprint: 'diff-fingerprint',
      createdAt: base.snapshot.createdAt,
      patch: [
        'diff --git a/src/example.ts b/src/example.ts',
        '--- a/src/example.ts',
        '+++ b/src/example.ts',
        '@@ -1,2 +1 @@',
        '-before',
        '+after',
        '-deleted only',
      ].join('\n'),
    });
    const item = snapshot.items[0]!;
    const bundle: ReviewBundle = {
      ...base,
      snapshot,
      insights: {
        ...base.insights,
        groups: [{ id: 'group-a', label: 'Example', reviewItemIds: [item.id] }],
        items: [{ ...base.insights.items[0]!, reviewItemId: item.id }],
      },
      progress: { ...base.progress, items: { [item.id]: { status: 'needs-review' } } },
    };
    createReview(bundle);
    const context = resolveReviewItemContext(snapshot, item.id);
    const removedRows = context.rows.filter((row) => row.kind === 'remove');

    const response = await callReviewApi(
      temp.dir,
      'POST',
      `/api/reviews/${WORKSPACE}/${REVISION}/questions`,
      {
        reviewItemId: item.id,
        selectedLineIds: removedRows.map((row) => row.id),
        body: 'Why are both old-side rows removed?',
      },
    );

    expect(response.statusCode).toBe(201);
    expect(response.json).toMatchObject({
      question: {
        selection: { kind: 'diff', selectedLineIds: removedRows.map((row) => row.id) },
        itemContext: context,
      },
    });
  });

  it('rejects injected source and selected lines outside the immutable item', async () => {
    createReview();
    const injected = await callReviewApi(
      temp.dir,
      'POST',
      `/api/reviews/${WORKSPACE}/${REVISION}/questions`,
      {
        reviewItemId: 'hunk-a',
        selectedLineIds: ['line-9'],
        source: 'client supplied source',
        body: 'Question?',
      },
    );

    expect(injected.statusCode).toBe(400);
  });

  it('returns a hydrated bundle and its readiness for an exact safe reference', async () => {
    createReview();
    const response = await callReviewApi(temp.dir, 'GET', `/api/reviews/${WORKSPACE}/${REVISION}`);

    expect(response.statusCode).toBe(200);
    expect(response.json).toMatchObject({
      bundle: { snapshot: { revisionId: REVISION } },
      readiness: { pending: 1 },
    });
  });

  it('reports an unfinalized empty scope as preparing and not ready', async () => {
    const pending = fixture();
    if (pending.snapshot.kind !== 'scope') throw new Error('expected scoped fixture');
    pending.snapshot.items = [];
    pending.insights.groups = [];
    pending.insights.items = [];
    pending.progress.items = {};
    createReview(pending);

    const response = await callReviewApi(temp.dir, 'GET', `/api/reviews/${WORKSPACE}/${REVISION}`);

    expect(response.statusCode).toBe(200);
    expect(response.json).toMatchObject({
      analysisFinalized: false,
      readiness: { ready: false, preparing: true, pending: 0 },
    });
  });

  it('uses one authoritative freshness result in bundle, progress, and question responses', async () => {
    const bundle = fixture();
    createReview(bundle);
    const context = resolveReviewItemContext(bundle.snapshot, 'hunk-a');
    const options: ReviewApiOptions = {
      compareSourceFreshness: () => ({ sourceChanged: true, captureFailed: false }),
    };

    const get = await callReviewApi(
      temp.dir,
      'GET',
      `/api/reviews/${WORKSPACE}/${REVISION}`,
      undefined,
      options,
    );
    const progress = await callReviewApi(
      temp.dir,
      'PATCH',
      `/api/reviews/${WORKSPACE}/${REVISION}/progress`,
      { reviewItemId: 'hunk-a', status: 'reviewed' },
      options,
    );
    const question = await callReviewApi(
      temp.dir,
      'POST',
      `/api/reviews/${WORKSPACE}/${REVISION}/questions`,
      {
        reviewItemId: 'hunk-a',
        selectedLineIds: [context.rows[0]!.id],
        body: 'Why?',
      },
      options,
    );

    for (const response of [get, progress, question]) {
      expect(response.json).toMatchObject({
        bundle: { sourceChanged: true },
        readiness: { ready: false, sourceChanged: true },
      });
    }
  });

  it('uses the daemon project root for freshness even when persisted repository metadata is tampered', async () => {
    const bundle = fixture();
    bundle.workspace.repository.root = '/attacker-controlled-repository';
    createReview(bundle);
    const observedRoots: string[] = [];

    const response = await callReviewApi(
      temp.dir,
      'GET',
      `/api/reviews/${WORKSPACE}/${REVISION}`,
      undefined,
      {
        compareSourceFreshness: (_snapshot, root) => {
          observedRoots.push(root);
          return { sourceChanged: false, captureFailed: false };
        },
      },
    );

    expect(response.statusCode).toBe(200);
    expect(observedRoots).toEqual([temp.dir]);
  });

  it('maps typed missing and corrupt review artifacts without leaking storage details', async () => {
    temp = makeTempDir();
    const missing = await callReviewApi(temp.dir, 'GET', `/api/reviews/${WORKSPACE}/${REVISION}`);
    expect(missing).toMatchObject({ statusCode: 404, json: { error: 'review_not_found' } });

    createReview();
    const workspacePath = join(temp.dir, '.synergy', 'reviews', WORKSPACE, 'workspace.json');
    writeFileSync(workspacePath, '{malformed', 'utf8');
    const corrupt = await callReviewApi(temp.dir, 'GET', `/api/reviews/${WORKSPACE}/${REVISION}`);
    expect(corrupt).toMatchObject({ statusCode: 422, json: { error: 'review_corrupt' } });
    expect(corrupt.body).not.toContain(workspacePath);
  });

  it('persists an active-review pointer without creating listener presence', async () => {
    createReview();
    const response = await callReviewApi(
      temp.dir,
      'POST',
      `/api/reviews/${WORKSPACE}/${REVISION}/active`,
      {},
    );

    expect(response.statusCode).toBe(200);
    const pointer = join(temp.dir, '.synergy', 'active-review.json');
    expect(existsSync(pointer)).toBe(true);
    expect(JSON.parse(readFileSync(pointer, 'utf8'))).toMatchObject({
      workspaceId: WORKSPACE,
      revisionId: REVISION,
    });
    expect(
      existsSync(
        join(
          temp.dir,
          '.synergy',
          'reviews',
          WORKSPACE,
          'revisions',
          REVISION,
          'questions',
          '.listeners',
        ),
      ),
    ).toBe(false);
  });

  it('preserves omitted progress fields and allows a note-only update', async () => {
    const store = createReview();
    await callReviewApi(temp.dir, 'PATCH', `/api/reviews/${WORKSPACE}/${REVISION}/progress`, {
      reviewItemId: 'hunk-a',
      note: 'Keep this note.',
    });
    await callReviewApi(temp.dir, 'PATCH', `/api/reviews/${WORKSPACE}/${REVISION}/progress`, {
      reviewItemId: 'hunk-a',
      status: 'reviewed',
    });

    expect(store.readBundle(WORKSPACE, REVISION).progress.items['hunk-a']).toMatchObject({
      status: 'reviewed',
      note: 'Keep this note.',
    });
    await callReviewApi(temp.dir, 'PATCH', `/api/reviews/${WORKSPACE}/${REVISION}/progress`, {
      reviewItemId: 'hunk-a',
      note: null,
    });
    expect(store.readBundle(WORKSPACE, REVISION).progress.items['hunk-a']).toEqual({
      status: 'reviewed',
      reviewedAt: expect.any(String),
    });
  });

  it('accepts a walkthrough cursor patch and returns the fresh bundle', async () => {
    createReview();
    const response = await callReviewApi(
      temp.dir,
      'PATCH',
      `/api/reviews/${WORKSPACE}/${REVISION}/progress`,
      { walkthrough: { activeGroupId: 'group-a', activeReviewItemId: 'hunk-a' } },
    );

    expect(response.statusCode).toBe(200);
    expect((response.json as { bundle: ReviewBundle }).bundle.progress.activeReviewItemId).toBe(
      'hunk-a',
    );
    expect((response.json as { bundle: ReviewBundle }).bundle.progress.activeGroupId).toBe(
      'group-a',
    );
  });

  it('rejects a patch mixing item and walkthrough keys', async () => {
    createReview();
    const response = await callReviewApi(
      temp.dir,
      'PATCH',
      `/api/reviews/${WORKSPACE}/${REVISION}/progress`,
      {
        reviewItemId: 'hunk-a',
        status: 'reviewed',
        walkthrough: { activeGroupId: 'group-a', activeReviewItemId: 'hunk-a' },
      },
    );

    expect(response).toMatchObject({ statusCode: 400, json: { error: 'invalid_request' } });
  });

  it('rejects a walkthrough patch with an unknown group', async () => {
    createReview();
    const response = await callReviewApi(
      temp.dir,
      'PATCH',
      `/api/reviews/${WORKSPACE}/${REVISION}/progress`,
      { walkthrough: { activeGroupId: 'nope', activeReviewItemId: 'hunk-a' } },
    );

    expect(response).toMatchObject({
      statusCode: 400,
      json: { error: 'invalid_walkthrough_position' },
    });
  });

  it('rejects a walkthrough patch with an unknown item', async () => {
    createReview();
    const response = await callReviewApi(
      temp.dir,
      'PATCH',
      `/api/reviews/${WORKSPACE}/${REVISION}/progress`,
      { walkthrough: { activeGroupId: 'group-a', activeReviewItemId: 'unknown-item' } },
    );

    expect(response).toMatchObject({
      statusCode: 400,
      json: { error: 'unknown_review_item' },
    });
  });

  function twoGroupBundle(): ReviewBundle {
    const base = fixture();
    return {
      ...base,
      snapshot: {
        ...base.snapshot,
        items: [
          ...base.snapshot.items,
          { ...base.snapshot.items[0]!, id: 'hunk-b', label: 'example-b' },
        ],
      },
      insights: {
        ...base.insights,
        groups: [
          { id: 'group-a', label: 'Example', reviewItemIds: ['hunk-a'] },
          { id: 'group-b', label: 'Example B', reviewItemIds: ['hunk-b'] },
        ],
        items: [...base.insights.items, { ...base.insights.items[0]!, reviewItemId: 'hunk-b' }],
      },
      progress: {
        ...base.progress,
        items: { ...base.progress.items, 'hunk-b': { status: 'needs-review' } },
      },
    };
  }

  it('rejects a walkthrough patch whose item is outside the named group, at parse time', async () => {
    createReview(twoGroupBundle());
    const response = await callReviewApi(
      temp.dir,
      'PATCH',
      `/api/reviews/${WORKSPACE}/${REVISION}/progress`,
      { walkthrough: { activeGroupId: 'group-a', activeReviewItemId: 'hunk-b' } },
    );

    expect(response).toMatchObject({
      statusCode: 400,
      json: { error: 'invalid_walkthrough_position' },
    });
  });

  it('treats an earlier/equal walkthrough cursor patch as a monotonic no-op returning 200', async () => {
    const store = createReview(twoGroupBundle());
    const advanced = await callReviewApi(
      temp.dir,
      'PATCH',
      `/api/reviews/${WORKSPACE}/${REVISION}/progress`,
      { walkthrough: { activeGroupId: 'group-b', activeReviewItemId: 'hunk-b' } },
    );
    expect(advanced.statusCode).toBe(200);

    const noop = await callReviewApi(
      temp.dir,
      'PATCH',
      `/api/reviews/${WORKSPACE}/${REVISION}/progress`,
      { walkthrough: { activeGroupId: 'group-a', activeReviewItemId: 'hunk-a' } },
    );

    expect(noop.statusCode).toBe(200);
    expect((noop.json as { bundle: ReviewBundle }).bundle).toBeDefined();
    expect(store.readBundle(WORKSPACE, REVISION).progress.activeReviewItemId).toBe('hunk-b');
    expect(store.readBundle(WORKSPACE, REVISION).progress.activeGroupId).toBe('group-b');
  });

  it('rejects mutation requests without JSON content type before persistence', async () => {
    createReview();
    const req = makeMockReq({
      method: 'PATCH',
      url: `/api/reviews/${WORKSPACE}/${REVISION}/progress`,
      body: { reviewItemId: 'hunk-a', status: 'reviewed' },
      headers: { 'content-type': 'text/plain' },
    });
    const { res, result } = makeMockRes();
    await handleReviewApi(
      req as unknown as IncomingMessage,
      res as unknown as ServerResponse,
      temp.dir,
    );

    expect(result().statusCode).toBe(415);
  });

  it.each([
    { label: 'empty', rawBody: '', expectedStatus: 400, expectedError: 'invalid_json' },
    { label: 'malformed', rawBody: '{oops', expectedStatus: 400, expectedError: 'invalid_json' },
    {
      label: 'oversized',
      rawBody: `{"reviewItemId":"hunk-a","note":"${'x'.repeat(70_000)}"}`,
      expectedStatus: 413,
      expectedError: 'body_too_large',
    },
  ])(
    'rejects $label JSON bodies deterministically',
    async ({ rawBody, expectedStatus, expectedError }) => {
      createReview();
      const req = makeMockReq({
        method: 'PATCH',
        url: `/api/reviews/${WORKSPACE}/${REVISION}/progress`,
        rawBody,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
      const { res, result } = makeMockRes();
      await handleReviewApi(
        req as unknown as IncomingMessage,
        res as unknown as ServerResponse,
        temp.dir,
      );
      expect(result()).toMatchObject({
        statusCode: expectedStatus,
        json: { error: expectedError },
      });
    },
  );

  it('maps request stream errors and wrong methods without mutating state', async () => {
    const store = createReview();
    const req = makeMockReq({
      method: 'PATCH',
      url: `/api/reviews/${WORKSPACE}/${REVISION}/progress`,
      emitError: true,
      headers: { 'content-type': 'application/json' },
    });
    const { res, result } = makeMockRes();
    await handleReviewApi(
      req as unknown as IncomingMessage,
      res as unknown as ServerResponse,
      temp.dir,
    );
    expect(result()).toMatchObject({ statusCode: 400, json: { error: 'invalid_request' } });

    const wrongMethod = await callReviewApi(
      temp.dir,
      'POST',
      `/api/reviews/${WORKSPACE}/${REVISION}`,
      {},
    );
    expect(wrongMethod).toMatchObject({ statusCode: 405, json: { error: 'method_not_allowed' } });
    expect(store.readBundle(WORKSPACE, REVISION).progress.items['hunk-a']?.status).toBe(
      'needs-review',
    );
  });
});
