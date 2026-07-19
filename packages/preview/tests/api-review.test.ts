import { type ReviewBundle, type ReviewRef, buildDiffSnapshot } from '@synergy/review-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type ReviewApiError,
  getReviewBundle,
  openReviewStream,
  patchReviewProgress,
  postReviewQuestion,
} from '../src/api.js';

const REFERENCE: ReviewRef = { workspaceId: 'workspace a', revisionId: 'revision/a' };
const fetchMock = vi.fn();

vi.stubGlobal('fetch', fetchMock);

function bundle(): ReviewBundle {
  const source = { kind: 'staged' as const, headSha: 'abc123' };
  return {
    workspace: {
      schemaVersion: 1,
      id: REFERENCE.workspaceId,
      repository: { root: '/repo', name: 'repo' },
      source,
      currentRevisionId: REFERENCE.revisionId,
      createdAt: '2026-07-19T10:00:00.000Z',
      updatedAt: '2026-07-19T10:00:00.000Z',
    },
    snapshot: {
      schemaVersion: 1,
      revisionId: REFERENCE.revisionId,
      source,
      fingerprint: 'fingerprint',
      createdAt: '2026-07-19T10:00:00.000Z',
      kind: 'scope',
      files: [
        { path: 'src/example.ts', binary: false, lines: [{ number: 1, text: 'export {};' }] },
      ],
      items: [
        {
          id: 'hunk-a',
          kind: 'code-section',
          path: 'src/example.ts',
          label: 'example',
          range: { start: 1, end: 1 },
          contentHash: 'content',
          locationHash: 'location',
        },
      ],
    },
    insights: { schemaVersion: 1, revisionId: REFERENCE.revisionId, groups: [], items: [] },
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

function payload() {
  return {
    bundle: bundle(),
    readiness: {
      ready: false,
      preparing: false,
      pending: 1,
      stale: 0,
      unanswered: 0,
      sourceChanged: false,
    },
    analysisFinalized: true,
  };
}

class FakeEventSource {
  readonly listeners = new Map<string, Array<(event: MessageEvent<string>) => void>>();
  closed = false;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {}
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  close(): void {
    this.closed = true;
  }
  emit(type: string, data: unknown, id = 'frame-a'): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data: JSON.stringify(data), lastEventId: id } as MessageEvent<string>);
    }
  }
}

afterEach(() => vi.resetAllMocks());

describe('review API client', () => {
  it('encodes references and validates durable progress responses', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(payload()), { status: 200 }));
    await patchReviewProgress(REFERENCE, 'hunk-a', { status: 'reviewed', note: 'checked' });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/reviews/workspace%20a/revision%2Fa/progress',
      expect.objectContaining({
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reviewItemId: 'hunk-a', status: 'reviewed', note: 'checked' }),
      }),
    );
  });

  it('rejects malformed successful review responses', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ bundle: { nope: true } }), { status: 200 }),
    );
    await expect(getReviewBundle(REFERENCE)).rejects.toThrow('invalid review response');
  });

  it('rejects a contradictory ready flag when durable work is still pending', async () => {
    const contradictory = payload();
    contradictory.readiness.ready = true;
    fetchMock.mockResolvedValue(new Response(JSON.stringify(contradictory), { status: 200 }));

    await expect(getReviewBundle(REFERENCE)).rejects.toThrow('invalid review response');
  });

  it('rejects deeply malformed source rows and mismatched references', async () => {
    const initial = payload();
    const deeplyMalformed = {
      ...initial,
      bundle: {
        ...initial.bundle,
        snapshot: {
          ...initial.bundle.snapshot,
          files: [{ path: 'src/example.ts', binary: false, lines: [{ number: 1 }] }],
        },
      },
    };
    fetchMock.mockResolvedValue(new Response(JSON.stringify(deeplyMalformed), { status: 200 }));
    await expect(getReviewBundle(REFERENCE)).rejects.toThrow('invalid review response');

    const wrongReference = payload();
    wrongReference.bundle.workspace.id = 'other-workspace';
    fetchMock.mockResolvedValue(new Response(JSON.stringify(wrongReference), { status: 200 }));
    await expect(getReviewBundle(REFERENCE)).rejects.toThrow('invalid review response');
  });

  it('decodes mixed and binary-only file relationships from real bundle fetches', async () => {
    const makeDiffPayload = (patch: string) => {
      const value = payload();
      const snapshot = buildDiffSnapshot({
        revisionId: REFERENCE.revisionId,
        source: value.bundle.snapshot.source,
        fingerprint: 'diff-fingerprint',
        createdAt: value.bundle.snapshot.createdAt,
        patch,
      });
      value.bundle.snapshot = snapshot;
      value.bundle.insights = {
        schemaVersion: 1,
        revisionId: snapshot.revisionId,
        groups: [
          { id: 'all', label: 'All changes', reviewItemIds: snapshot.items.map((item) => item.id) },
        ],
        items: snapshot.items.map((item) => ({
          reviewItemId: item.id,
          description: 'Captured change.',
          confidence: 'high' as const,
          evidencePaths: [item.path],
        })),
      };
      value.bundle.progress.items = Object.fromEntries(
        snapshot.items.map((item) => [item.id, { status: 'needs-review' as const }]),
      );
      value.readiness.pending = snapshot.items.length;
      return value;
    };
    const binaryPatch = [
      'diff --git a/assets/logo.png b/assets/logo.png',
      'Binary files a/assets/logo.png and b/assets/logo.png differ',
    ].join('\n');
    const mixed = makeDiffPayload(
      [
        'diff --git a/src/example.ts b/src/example.ts',
        '--- a/src/example.ts',
        '+++ b/src/example.ts',
        '@@ -1 +1 @@',
        '-before',
        '+after',
        binaryPatch,
      ].join('\n'),
    );
    const binaryOnly = makeDiffPayload(binaryPatch);

    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify(mixed), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(binaryOnly), { status: 200 }));

    await expect(getReviewBundle(REFERENCE)).resolves.toMatchObject({
      bundle: { snapshot: { items: [{ kind: 'hunk' }, { kind: 'file' }] } },
    });
    await expect(getReviewBundle(REFERENCE)).resolves.toMatchObject({
      bundle: { snapshot: { items: [{ kind: 'file', label: 'Binary file changed' }] } },
    });
  });

  it('rejects missing, stray, and mismatched file-level relationships', async () => {
    const valid = payload();
    const snapshot = buildDiffSnapshot({
      revisionId: REFERENCE.revisionId,
      source: valid.bundle.snapshot.source,
      fingerprint: 'binary-fingerprint',
      createdAt: valid.bundle.snapshot.createdAt,
      patch: [
        'diff --git a/assets/logo.png b/assets/logo.png',
        'Binary files a/assets/logo.png and b/assets/logo.png differ',
      ].join('\n'),
    });
    valid.bundle.snapshot = snapshot;
    valid.bundle.progress.items = { [snapshot.items[0]!.id]: { status: 'needs-review' } };
    valid.readiness.pending = 1;
    const missing = structuredClone(valid);
    if (missing.bundle.snapshot.kind !== 'diff') throw new Error('expected diff fixture');
    missing.bundle.snapshot.files[0]!.reviewItemId = undefined;
    const mismatched = structuredClone(valid);
    if (mismatched.bundle.snapshot.kind !== 'diff') throw new Error('expected diff fixture');
    mismatched.bundle.snapshot.files[0]!.reviewItemId = 'file-missing';
    const stray = structuredClone(valid);
    if (stray.bundle.snapshot.kind !== 'diff') throw new Error('expected diff fixture');
    const hunkSnapshot = buildDiffSnapshot({
      revisionId: REFERENCE.revisionId,
      source: stray.bundle.snapshot.source,
      fingerprint: 'hunk-fingerprint',
      createdAt: stray.bundle.snapshot.createdAt,
      patch: [
        'diff --git a/src/example.ts b/src/example.ts',
        '--- a/src/example.ts',
        '+++ b/src/example.ts',
        '@@ -1 +1 @@',
        '-before',
        '+after',
      ].join('\n'),
    });
    const hunkItem = hunkSnapshot.items[0]!;
    hunkSnapshot.files[0]!.reviewItemId = hunkItem.id;
    hunkSnapshot.files[0]!.reviewItemContentHash = hunkItem.contentHash;
    hunkSnapshot.files[0]!.reviewItemLocationHash = hunkItem.locationHash;
    stray.bundle.snapshot = hunkSnapshot;
    stray.bundle.progress.items = { [hunkItem.id]: { status: 'needs-review' } };
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify(missing), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(mismatched), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(stray), { status: 200 }));

    await expect(getReviewBundle(REFERENCE)).rejects.toThrow('invalid review response');
    await expect(getReviewBundle(REFERENCE)).rejects.toThrow('invalid review response');
    await expect(getReviewBundle(REFERENCE)).rejects.toThrow('invalid review response');
  });

  it('accepts canonical blank source text and empty insight descriptions', async () => {
    const valid = payload();
    if (valid.bundle.snapshot.kind !== 'scope') throw new Error('expected scoped test fixture');
    valid.bundle.snapshot.files[0]!.lines[0]!.text = '';
    valid.bundle.insights.items = [
      {
        reviewItemId: 'hunk-a',
        description: '',
        confidence: 'low',
        evidencePaths: ['src/example.ts'],
      },
    ];
    fetchMock.mockResolvedValue(new Response(JSON.stringify(valid), { status: 200 }));

    await expect(getReviewBundle(REFERENCE)).resolves.toMatchObject({ bundle: valid.bundle });
  });

  it('accepts a question with an empty optional insight description', async () => {
    const valid = payload();
    if (valid.bundle.snapshot.kind !== 'scope') throw new Error('expected scoped test fixture');
    const item = valid.bundle.snapshot.items[0]!;
    const queued = {
      schemaVersion: 1 as const,
      id: 'question-a',
      workspaceId: REFERENCE.workspaceId,
      revisionId: REFERENCE.revisionId,
      path: item.path,
      reviewItemId: item.id,
      selection: { kind: 'scope' as const, selectedLineIds: ['row-hunk-a-0'] },
      itemContext: {
        item,
        rows: [{ id: 'row-hunk-a-0', kind: 'scope' as const, line: 1, text: 'export {};' }],
      },
      description: '',
      body: 'Why?',
      createdAt: '2026-07-19T10:00:00.000Z',
      generation: 0,
      status: 'queued' as const,
    };
    valid.bundle.questions = [queued];
    valid.readiness.unanswered = 1;
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ ...valid, question: queued }), { status: 201 }),
    );

    await expect(
      postReviewQuestion(REFERENCE, item.id, ['row-hunk-a-0'], 'Why?'),
    ).resolves.toMatchObject({ question: queued });
  });

  it('returns sanitized server failures without exposing a non-JSON body', async () => {
    fetchMock.mockResolvedValue(new Response('private disk path', { status: 500 }));
    await expect(getReviewBundle(REFERENCE)).rejects.toEqual(
      expect.objectContaining<Partial<ReviewApiError>>({ status: 500, code: 'request_failed' }),
    );
  });

  it('sends exact line IDs when queueing a question', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ question: { ...bundle().questions[0], schemaVersion: 1 }, ...payload() }),
        { status: 201 },
      ),
    );
    await postReviewQuestion(REFERENCE, 'hunk-a', ['scope:src/example.ts:1'], 'Why?').catch(
      () => undefined,
    );
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/reviews/workspace%20a/revision%2Fa/questions',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          reviewItemId: 'hunk-a',
          selectedLineIds: ['scope:src/example.ts:1'],
          body: 'Why?',
        }),
      }),
    );
  });

  it('decodes typed SSE frames and exposes their durable IDs', () => {
    let source: FakeEventSource | undefined;
    const onFrame = vi.fn();
    const connection = openReviewStream(
      REFERENCE,
      { onFrame, onOpen: vi.fn(), onError: vi.fn() },
      (url) => {
        source = new FakeEventSource(url);
        return source;
      },
    );
    source?.emit('source', { type: 'source', changed: true, captureFailed: false }, 'source:new');
    expect(onFrame).toHaveBeenCalledWith(
      { type: 'source', changed: true, captureFailed: false },
      'source:new',
    );
    connection.close();
    expect(source?.closed).toBe(true);
  });
});
