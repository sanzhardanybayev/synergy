import { EventEmitter } from 'node:events';
import { writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import {
  type ReviewBundle,
  type ReviewSourceFreshness,
  type ReviewSourceFreshnessAsyncOptions,
  applyCodeSections,
  type compareReviewSourceFreshnessAsync,
  createQuestionQueue,
  createReviewStore,
  resolveReviewItemContext,
  touchReviewListener,
} from '@synergy/review-core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type ReviewStreamEnvironment,
  type ReviewStreamWatcher,
  handleReviewStream,
} from '../../src/server/review-stream.js';
import { makeMockRes, makeTempDir } from './helpers.js';

const REFERENCE = { workspaceId: 'workspace-a', revisionId: 'revision-a' };
const NOW = Date.parse('2026-07-19T10:00:00.000Z');

function createBundle(revisionId = REFERENCE.revisionId): ReviewBundle {
  const source = { kind: 'staged' as const, headSha: 'abc123' };
  return {
    workspace: {
      schemaVersion: 1,
      id: REFERENCE.workspaceId,
      repository: { root: '/repo', name: 'repo' },
      source,
      currentRevisionId: revisionId,
      createdAt: '2026-07-19T10:00:00.000Z',
      updatedAt: '2026-07-19T10:00:00.000Z',
    },
    snapshot: {
      schemaVersion: 1,
      revisionId,
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
          contentHash: '2e29cd9a98755c46896f7a2d56524db2d6d96b248e36db46de14c30bf47c8d05',
          locationHash: 'location',
        },
      ],
    },
    insights: {
      schemaVersion: 1,
      revisionId,
      groups: [{ id: 'group-a', label: 'Example', reviewItemIds: ['hunk-a'] }],
      items: [
        {
          reviewItemId: 'hunk-a',
          description: 'Example.',
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

function streamRequest(): EventEmitter & { url: string; method: string } {
  const request = new EventEmitter() as EventEmitter & { url: string; method: string };
  request.url = `/api/reviews/${REFERENCE.workspaceId}/${REFERENCE.revisionId}/stream`;
  request.method = 'GET';
  return request;
}

interface CapturedFrame {
  event?: string;
  id?: string;
  data: Record<string, unknown>;
}

function parseFrames(chunks: string[]): CapturedFrame[] {
  return chunks.flatMap((chunk) =>
    chunk
      .split('\n\n')
      .filter((block) => block.includes('data: '))
      .map((block) => {
        const lines = block.split('\n');
        const data = lines.find((line) => line.startsWith('data: '));
        return {
          event: lines.find((line) => line.startsWith('event: '))?.slice('event: '.length),
          id: lines.find((line) => line.startsWith('id: '))?.slice('id: '.length),
          data: JSON.parse(data?.slice('data: '.length) ?? '{}') as Record<string, unknown>,
        };
      }),
  );
}

class FakeWatcher extends EventEmitter implements ReviewStreamWatcher {
  isClosed = false;

  close(): void {
    this.isClosed = true;
  }
}

class FakeEnvironment implements ReviewStreamEnvironment {
  nowMs = NOW;
  freshness: ReviewSourceFreshness = { sourceChanged: false, captureFailed: false };
  readonly watchPaths: string[] = [];
  readonly watchListeners: Array<(filename: string | Buffer | null) => void> = [];
  readonly watchers: FakeWatcher[] = [];
  readonly timeouts = new Map<number, { callback: () => void; delay: number }>();
  readonly intervals = new Map<number, { callback: () => void; delay: number }>();
  onWatch?: (path: string, index: number) => void;
  onCompare?: (call: number) => void;
  asyncFreshnessHandler?: typeof compareReviewSourceFreshnessAsync;
  readonly asyncOptions: ReviewSourceFreshnessAsyncOptions[] = [];
  readonly freshnessRoots: string[] = [];
  watchFailureAt?: number;
  maxQueuedRecords?: number;
  freshnessTimeoutMs?: number;
  private nextTimer = 1;
  private compareCalls = 0;

  watch(path: string, listener: (filename: string | Buffer | null) => void): ReviewStreamWatcher {
    const index = this.watchPaths.length;
    if (this.watchFailureAt === index) throw new Error('private watcher construction detail');
    this.watchPaths.push(path);
    this.watchListeners.push(listener);
    const watcher = new FakeWatcher();
    this.watchers.push(watcher);
    this.onWatch?.(path, index);
    return watcher;
  }

  setTimeout(callback: () => void, delay: number): ReturnType<typeof setTimeout> {
    const id = this.nextTimer++;
    this.timeouts.set(id, { callback, delay });
    return id as unknown as ReturnType<typeof setTimeout>;
  }

  clearTimeout(timer: ReturnType<typeof setTimeout>): void {
    this.timeouts.delete(timer as unknown as number);
  }

  setInterval(callback: () => void, delay: number): ReturnType<typeof setInterval> {
    const id = this.nextTimer++;
    this.intervals.set(id, { callback, delay });
    return id as unknown as ReturnType<typeof setInterval>;
  }

  clearInterval(timer: ReturnType<typeof setInterval>): void {
    this.intervals.delete(timer as unknown as number);
  }

  now(): number {
    return this.nowMs;
  }

  compareSourceFreshnessAsync: typeof compareReviewSourceFreshnessAsync = (
    snapshot,
    root,
    options = {},
  ) => {
    this.compareCalls += 1;
    this.freshnessRoots.push(root);
    this.onCompare?.(this.compareCalls);
    this.asyncOptions.push(options);
    return this.asyncFreshnessHandler
      ? this.asyncFreshnessHandler(snapshot, root, options)
      : Promise.resolve(this.freshness);
  };

  runTimeout(delay: number): void {
    const match = [...this.timeouts.entries()].find(([, timer]) => timer.delay === delay);
    if (!match) throw new Error(`missing timeout ${delay}`);
    this.timeouts.delete(match[0]);
    match[1].callback();
  }

  runInterval(delay: number): void {
    const match = [...this.intervals.values()].find((timer) => timer.delay === delay);
    if (!match) throw new Error(`missing interval ${delay}`);
    match.callback();
  }
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: (value: T) => void = () => undefined;
  let rejectPromise: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

async function settleAsyncWork(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function makeStreamResponse(writeResults: boolean[] = []): {
  res: EventEmitter & {
    statusCode: number;
    headers: Record<string, string>;
    writableEnded: boolean;
    writeHead(status: number, headers: Record<string, string>): void;
    write(chunk: string): boolean;
    end(): void;
  };
  chunks: string[];
  endCount: () => number;
} {
  const chunks: string[] = [];
  let ends = 0;
  const response = Object.assign(new EventEmitter(), {
    statusCode: 0,
    headers: {} as Record<string, string>,
    writableEnded: false,
    writeHead(status: number, headers: Record<string, string>) {
      response.statusCode = status;
      response.headers = headers;
    },
    write(chunk: string) {
      chunks.push(chunk);
      return writeResults.shift() ?? true;
    },
    end() {
      ends += 1;
      response.writableEnded = true;
    },
  });
  return { res: response, chunks, endCount: () => ends };
}

function persistBundle(root: string, bundle = createBundle()): void {
  createReviewStore(root).createRevision(
    bundle.workspace,
    bundle.snapshot,
    bundle.insights,
    bundle.progress,
  );
}

function enqueueQuestion(root: string, id: string): void {
  const bundle = createReviewStore(root).readBundle(REFERENCE.workspaceId, REFERENCE.revisionId);
  const context = resolveReviewItemContext(bundle.snapshot, 'hunk-a');
  createQuestionQueue(root, REFERENCE).enqueue({
    id,
    path: 'src/example.ts',
    reviewItemId: 'hunk-a',
    selection: { kind: 'scope', selectedLineIds: [context.rows[0]!.id] },
    itemContext: context,
    description: 'Example.',
    body: `Question ${id}?`,
    createdAt: new Date(NOW).toISOString(),
  });
}

function answerQuestion(root: string, questionId: string): void {
  const queue = createQuestionQueue(root, REFERENCE);
  const claim = queue.claim(questionId, 'listener-answer', NOW, 60_000);
  if (!claim.ok || !claim.question?.claim) throw new Error('question claim failed');
  queue.answer(
    questionId,
    'listener-answer',
    claim.question.claim.token,
    `Answer ${questionId}`,
    NOW + 1,
  );
}

describe('review stream', () => {
  let temp: ReturnType<typeof makeTempDir>;
  afterEach(() => temp?.cleanup());

  it('starts freshness asynchronously with a timeout and keeps the caller event loop responsive', async () => {
    temp = makeTempDir();
    persistBundle(temp.dir);
    const environment = new FakeEnvironment();
    const firstFreshness = deferred<ReviewSourceFreshness>();
    let asyncCalls = 0;
    environment.freshnessTimeoutMs = 1_234;
    environment.asyncFreshnessHandler = () =>
      ++asyncCalls === 1 ? firstFreshness.promise : Promise.resolve(environment.freshness);
    const response = makeStreamResponse();

    const start = handleReviewStream(
      streamRequest() as unknown as IncomingMessage,
      response.res as unknown as ServerResponse,
      temp.dir,
      REFERENCE,
      environment,
    );
    let callerTurnRan = false;
    await Promise.resolve().then(() => {
      callerTurnRan = true;
    });

    expect(callerTurnRan).toBe(true);
    expect(response.chunks).toHaveLength(0);
    expect(environment.asyncOptions[0]).toMatchObject({ timeoutMs: 1_234 });
    expect(environment.asyncOptions[0]?.signal).toBeInstanceOf(AbortSignal);
    firstFreshness.resolve(environment.freshness);
    await start;
    expect(response.chunks.length).toBeGreaterThan(0);
  });

  it('uses the daemon project root for SSE freshness despite tampered workspace metadata', async () => {
    temp = makeTempDir();
    const bundle = createBundle();
    bundle.workspace.repository.root = '/attacker-controlled-repository';
    persistBundle(temp.dir, bundle);
    const environment = new FakeEnvironment();
    const request = streamRequest();
    const response = makeStreamResponse();

    await handleReviewStream(
      request as unknown as IncomingMessage,
      response.res as unknown as ServerResponse,
      temp.dir,
      REFERENCE,
      environment,
    );

    expect(environment.freshnessRoots[0]).toBe(temp.dir);
    request.emit('close');
  });

  it('never overlaps freshness polls and coalesces one pending refresh', async () => {
    temp = makeTempDir();
    persistBundle(temp.dir);
    const environment = new FakeEnvironment();
    const slowPoll = deferred<ReviewSourceFreshness>();
    let calls = 0;
    let active = 0;
    let maxActive = 0;
    environment.asyncFreshnessHandler = () => {
      calls += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      const result = calls === 3 ? slowPoll.promise : Promise.resolve(environment.freshness);
      return result.finally(() => {
        active -= 1;
      });
    };
    await handleReviewStream(
      streamRequest() as unknown as IncomingMessage,
      makeStreamResponse().res as unknown as ServerResponse,
      temp.dir,
      REFERENCE,
      environment,
    );

    environment.runInterval(5_000);
    environment.runInterval(5_000);
    environment.watchListeners[1]?.('progress.json');
    environment.runTimeout(80);
    expect(calls).toBe(3);
    expect(maxActive).toBe(1);

    slowPoll.resolve(environment.freshness);
    await settleAsyncWork();
    expect(calls).toBe(4);
    expect(maxActive).toBe(1);
  });

  it('aborts an in-flight poll on close and ignores its late rejection', async () => {
    temp = makeTempDir();
    persistBundle(temp.dir);
    const environment = new FakeEnvironment();
    const slowPoll = deferred<ReviewSourceFreshness>();
    let calls = 0;
    let pollSignal: AbortSignal | undefined;
    environment.asyncFreshnessHandler = (_snapshot, _root, options) => {
      calls += 1;
      if (calls === 3) {
        pollSignal = options?.signal;
        return slowPoll.promise;
      }
      return Promise.resolve(environment.freshness);
    };
    const request = streamRequest();
    const response = makeStreamResponse();
    await handleReviewStream(
      request as unknown as IncomingMessage,
      response.res as unknown as ServerResponse,
      temp.dir,
      REFERENCE,
      environment,
    );
    environment.runInterval(5_000);
    request.emit('close');
    const writesAtClose = response.chunks.length;

    expect(pollSignal?.aborted).toBe(true);
    slowPoll.reject(new Error('private late worker rejection'));
    await settleAsyncWork();
    expect(response.chunks).toHaveLength(writesAtClose);
    expect(environment.intervals).toHaveLength(0);
    expect(environment.timeouts).toHaveLength(0);
  });

  it('fails freshness closed on timeout/error and recovers on the next poll', async () => {
    temp = makeTempDir();
    persistBundle(temp.dir);
    const environment = new FakeEnvironment();
    let calls = 0;
    environment.asyncFreshnessHandler = () => {
      calls += 1;
      if (calls === 3) return Promise.reject(new Error('private timeout detail'));
      return Promise.resolve(environment.freshness);
    };
    const response = makeStreamResponse();
    await handleReviewStream(
      streamRequest() as unknown as IncomingMessage,
      response.res as unknown as ServerResponse,
      temp.dir,
      REFERENCE,
      environment,
    );
    environment.runInterval(5_000);
    await settleAsyncWork();
    let frames = parseFrames(response.chunks);
    expect(frames.filter((frame) => frame.data.type === 'source').at(-1)?.data).toMatchObject({
      changed: true,
      captureFailed: true,
    });
    expect(frames.at(-1)?.data).toEqual({
      type: 'interruption',
      code: 'source_capture_failed',
      recoverable: true,
    });
    expect(response.chunks.join('')).not.toContain('private timeout detail');

    environment.runInterval(5_000);
    await settleAsyncWork();
    frames = parseFrames(response.chunks);
    expect(frames.filter((frame) => frame.data.type === 'source').at(-1)?.data).toMatchObject({
      changed: false,
      captureFailed: false,
    });
  });

  it('installs no timers when the post-attach authoritative read fails', async () => {
    temp = makeTempDir();
    persistBundle(temp.dir);
    const environment = new FakeEnvironment();
    environment.onCompare = (call) => {
      if (call === 1) {
        writeFileSync(
          `${temp.dir}/.synergy/reviews/${REFERENCE.workspaceId}/workspace.json`,
          '{malformed',
        );
      }
    };
    const response = makeStreamResponse();
    await handleReviewStream(
      streamRequest() as unknown as IncomingMessage,
      response.res as unknown as ServerResponse,
      temp.dir,
      REFERENCE,
      environment,
    );

    const writesAtClose = response.chunks.length;
    expect(parseFrames(response.chunks).at(-1)?.data).toEqual({
      type: 'interruption',
      code: 'review_unavailable',
      recoverable: false,
    });
    expect(environment.watchers.every((watcher) => watcher.isClosed)).toBe(true);
    expect(environment.timeouts).toHaveLength(0);
    expect(environment.intervals).toHaveLength(0);
    environment.watchListeners[1]?.('progress.json');
    expect(response.chunks).toHaveLength(writesAtClose);
  });

  it('attaches scoped watchers before the authoritative snapshot and deterministically replays records once', async () => {
    temp = makeTempDir();
    persistBundle(temp.dir);
    enqueueQuestion(temp.dir, 'question-before-connect');
    const environment = new FakeEnvironment();
    const response = makeStreamResponse();
    environment.onWatch = () => {
      expect(response.chunks).toHaveLength(0);
    };
    environment.onCompare = (call) => {
      if (call === 1) enqueueQuestion(temp.dir, 'question-in-attach-gap');
    };

    await handleReviewStream(
      streamRequest() as unknown as IncomingMessage,
      response.res as unknown as ServerResponse,
      temp.dir,
      REFERENCE,
      environment,
    );

    expect(environment.watchPaths).toHaveLength(2);
    expect(environment.watchPaths[0]).toContain('/workspace-a');
    expect(environment.watchPaths[1]).toContain('/revision-a');
    const frames = parseFrames(response.chunks);
    expect(frames.filter((frame) => frame.data.type === 'presence')).toHaveLength(1);
    expect(frames.filter((frame) => frame.data.type === 'progress')).toHaveLength(2);
    expect(frames.filter((frame) => frame.data.type === 'source')).toHaveLength(1);
    expect(
      frames.filter((frame) => frame.data.type === 'question').map((frame) => frame.id),
    ).toEqual([
      expect.stringContaining('question-before-connect'),
      expect.stringContaining('question-in-attach-gap'),
    ]);
    expect(frames.every((frame) => frame.event === frame.data.type && frame.id)).toBe(true);
  });

  it('replays current questions and answers with stable event IDs on every reconnect', async () => {
    temp = makeTempDir();
    persistBundle(temp.dir);
    enqueueQuestion(temp.dir, 'question-reconnect');
    answerQuestion(temp.dir, 'question-reconnect');

    const first = makeStreamResponse();
    await handleReviewStream(
      streamRequest() as unknown as IncomingMessage,
      first.res as unknown as ServerResponse,
      temp.dir,
      REFERENCE,
      new FakeEnvironment(),
    );
    const second = makeStreamResponse();
    await handleReviewStream(
      streamRequest() as unknown as IncomingMessage,
      second.res as unknown as ServerResponse,
      temp.dir,
      REFERENCE,
      new FakeEnvironment(),
    );

    const recordIds = (chunks: string[]) =>
      parseFrames(chunks)
        .filter((frame) => frame.data.type === 'question' || frame.data.type === 'answer')
        .map((frame) => frame.id);
    expect(recordIds(first.chunks)).toEqual(recordIds(second.chunks));
    expect(recordIds(first.chunks)).toEqual([
      expect.stringContaining('question:question-reconnect'),
      expect.stringContaining('answer:answer-question-reconnect'),
    ]);
  });

  it('uses one freshness result for source and readiness, polls changes, and reports capture interruption', async () => {
    temp = makeTempDir();
    persistBundle(temp.dir);
    const environment = new FakeEnvironment();
    const response = makeStreamResponse();
    await handleReviewStream(
      streamRequest() as unknown as IncomingMessage,
      response.res as unknown as ServerResponse,
      temp.dir,
      REFERENCE,
      environment,
    );

    environment.freshness = { sourceChanged: true, captureFailed: false };
    environment.runInterval(5_000);
    await settleAsyncWork();
    let frames = parseFrames(response.chunks);
    const changedSource = frames.filter((frame) => frame.data.type === 'source').at(-1);
    const changedProgress = frames.filter((frame) => frame.data.type === 'progress').at(-1);
    expect(changedSource?.data).toMatchObject({ changed: true, captureFailed: false });
    expect(changedProgress?.data.readiness).toMatchObject({ ready: false, sourceChanged: true });

    environment.freshness = { sourceChanged: true, captureFailed: true };
    environment.runInterval(5_000);
    await settleAsyncWork();
    frames = parseFrames(response.chunks);
    expect(frames.at(-1)?.data).toEqual({
      type: 'interruption',
      code: 'source_capture_failed',
      recoverable: true,
    });
    expect(response.chunks.join('')).not.toContain('private');
  });

  it('publishes authoritative preparation and finalization state for an open scoped review', async () => {
    temp = makeTempDir();
    const pending = createBundle();
    if (pending.snapshot.kind !== 'scope') throw new Error('expected scoped fixture');
    pending.snapshot.items = [];
    pending.insights.groups = [];
    pending.insights.items = [];
    pending.progress.items = {};
    persistBundle(temp.dir, pending);
    const environment = new FakeEnvironment();
    const response = makeStreamResponse();

    await handleReviewStream(
      streamRequest() as unknown as IncomingMessage,
      response.res as unknown as ServerResponse,
      temp.dir,
      REFERENCE,
      environment,
    );

    expect(
      parseFrames(response.chunks).find((frame) => frame.data.type === 'progress')?.data,
    ).toMatchObject({
      analysisFinalized: false,
      readiness: { ready: false, preparing: true },
    });

    const finalizedSnapshot = applyCodeSections(pending.snapshot, [
      { path: 'src/example.ts', label: 'example', start: 1, end: 1 },
    ]);
    const finalizedItem = finalizedSnapshot.items[0]!;
    createReviewStore(temp.dir).finalizeScopeAnalysis(
      REFERENCE.workspaceId,
      REFERENCE.revisionId,
      finalizedSnapshot,
      {
        schemaVersion: 1,
        revisionId: REFERENCE.revisionId,
        groups: [{ id: 'group-a', label: 'Example', reviewItemIds: [finalizedItem.id] }],
        items: [
          {
            reviewItemId: finalizedItem.id,
            description: 'Example.',
            confidence: 'high',
            evidencePaths: ['src/example.ts'],
          },
        ],
      },
      {
        schemaVersion: 1,
        updatedAt: '2026-07-19T10:01:00.000Z',
        items: { [finalizedItem.id]: { status: 'needs-review' } },
      },
    );
    environment.watchListeners[1]?.('bundle.json');
    environment.runTimeout(80);
    await settleAsyncWork();

    expect(
      parseFrames(response.chunks)
        .filter((frame) => frame.data.type === 'progress')
        .at(-1)?.data,
    ).toMatchObject({
      analysisFinalized: true,
      readiness: { ready: false, preparing: false, pending: 1 },
    });
  });

  it('validates listener records and schedules expiry without a filesystem event', async () => {
    temp = makeTempDir();
    persistBundle(temp.dir);
    touchReviewListener(temp.dir, REFERENCE, 'listener-valid', NOW);
    const listeners = join(
      temp.dir,
      '.synergy/reviews/workspace-a/revisions/revision-a/questions/.listeners',
    );
    writeFileSync(join(listeners, 'junk.txt'), 'junk');
    writeFileSync(
      join(listeners, 'wrong-name.json'),
      JSON.stringify({ listenerId: 'different-name', updatedAt: new Date(NOW).toISOString() }),
    );
    writeFileSync(
      join(listeners, 'future.json'),
      JSON.stringify({ listenerId: 'future', updatedAt: new Date(NOW + 999_999).toISOString() }),
    );
    const environment = new FakeEnvironment();
    const response = makeStreamResponse();
    await handleReviewStream(
      streamRequest() as unknown as IncomingMessage,
      response.res as unknown as ServerResponse,
      temp.dir,
      REFERENCE,
      environment,
    );
    expect(
      parseFrames(response.chunks).find((frame) => frame.data.type === 'presence')?.data,
    ).toEqual({ type: 'presence', listening: true });

    environment.nowMs = NOW + 90_000;
    environment.runTimeout(90_000);
    expect(
      parseFrames(response.chunks)
        .filter((frame) => frame.data.type === 'presence')
        .at(-1)?.data,
    ).toEqual({ type: 'presence', listening: false });
  });

  it('fails visibly when watcher construction or a live watcher fails', async () => {
    temp = makeTempDir();
    persistBundle(temp.dir);
    const constructionEnvironment = new FakeEnvironment();
    constructionEnvironment.watchFailureAt = 1;
    const preStreamResponse = makeMockRes();
    await handleReviewStream(
      streamRequest() as unknown as IncomingMessage,
      preStreamResponse.res as ServerResponse,
      temp.dir,
      REFERENCE,
      constructionEnvironment,
    );
    expect(preStreamResponse.result()).toMatchObject({
      statusCode: 503,
      json: { error: 'stream_unavailable' },
    });
    expect(constructionEnvironment.watchers[0]?.isClosed).toBe(true);

    const runtimeEnvironment = new FakeEnvironment();
    const runtimeResponse = makeStreamResponse();
    await handleReviewStream(
      streamRequest() as unknown as IncomingMessage,
      runtimeResponse.res as unknown as ServerResponse,
      temp.dir,
      REFERENCE,
      runtimeEnvironment,
    );
    runtimeEnvironment.watchers[1]?.emit('error', new Error('private watcher error'));
    expect(parseFrames(runtimeResponse.chunks).at(-1)?.data).toEqual({
      type: 'interruption',
      code: 'stream_unavailable',
      recoverable: false,
    });
    expect(runtimeResponse.endCount()).toBe(1);
    expect(runtimeResponse.chunks.join('')).not.toContain('private watcher error');
  });

  it('debounces only relevant exact-revision artifacts and ignores unrelated names', async () => {
    temp = makeTempDir();
    persistBundle(temp.dir);
    const environment = new FakeEnvironment();
    const response = makeStreamResponse();
    await handleReviewStream(
      streamRequest() as unknown as IncomingMessage,
      response.res as unknown as ServerResponse,
      temp.dir,
      REFERENCE,
      environment,
    );
    const initialWrites = response.chunks.length;
    environment.watchListeners[0]?.('another-workspace.json');
    environment.watchListeners[1]?.('../revision-b/progress.json');
    expect([...environment.timeouts.values()].filter((timer) => timer.delay === 80)).toHaveLength(
      0,
    );

    environment.watchListeners[1]?.('progress.json');
    environment.watchListeners[1]?.('questions/question-1.json');
    expect([...environment.timeouts.values()].filter((timer) => timer.delay === 80)).toHaveLength(
      1,
    );
    environment.runTimeout(80);
    await settleAsyncWork();
    expect(response.chunks.length).toBe(initialWrites);
  });

  it.each(['close', 'aborted'] as const)(
    'cleans timers and watchers on request %s and does not write afterward',
    async (event) => {
      temp = makeTempDir();
      persistBundle(temp.dir);
      const environment = new FakeEnvironment();
      const response = makeStreamResponse();
      const request = streamRequest();
      await handleReviewStream(
        request as unknown as IncomingMessage,
        response.res as unknown as ServerResponse,
        temp.dir,
        REFERENCE,
        environment,
      );
      request.emit(event);
      const writesAtClose = response.chunks.length;
      environment.watchListeners[1]?.('progress.json');
      expect(environment.watchers.every((watcher) => watcher.isClosed)).toBe(true);
      expect(environment.timeouts).toHaveLength(0);
      expect(environment.intervals).toHaveLength(0);
      expect(response.chunks).toHaveLength(writesAtClose);
    },
  );

  it.each(['close', 'error'] as const)(
    'cleans on response %s without an unhandled response error or extra end',
    async (event) => {
      temp = makeTempDir();
      persistBundle(temp.dir);
      const environment = new FakeEnvironment();
      const response = makeStreamResponse();
      await handleReviewStream(
        streamRequest() as unknown as IncomingMessage,
        response.res as unknown as ServerResponse,
        temp.dir,
        REFERENCE,
        environment,
      );
      response.res.emit(event, event === 'error' ? new Error('socket failed') : undefined);
      expect(environment.watchers.every((watcher) => watcher.isClosed)).toBe(true);
      expect(response.endCount()).toBe(0);
    },
  );

  it('pauses on backpressure, coalesces state until drain, and terminates on bounded overflow', async () => {
    temp = makeTempDir();
    persistBundle(temp.dir);
    enqueueQuestion(temp.dir, 'question-one');
    enqueueQuestion(temp.dir, 'question-two');
    const environment = new FakeEnvironment();
    const response = makeStreamResponse([false]);
    await handleReviewStream(
      streamRequest() as unknown as IncomingMessage,
      response.res as unknown as ServerResponse,
      temp.dir,
      REFERENCE,
      environment,
    );
    expect(response.chunks).toHaveLength(1);
    response.res.emit('drain');
    expect(parseFrames(response.chunks).map((frame) => frame.data.type)).toEqual([
      'presence',
      'source',
      'progress',
      'question',
      'question',
    ]);

    const overflowEnvironment = new FakeEnvironment();
    overflowEnvironment.maxQueuedRecords = 1;
    const overflowResponse = makeStreamResponse([false]);
    await handleReviewStream(
      streamRequest() as unknown as IncomingMessage,
      overflowResponse.res as unknown as ServerResponse,
      temp.dir,
      REFERENCE,
      overflowEnvironment,
    );
    expect(overflowResponse.endCount()).toBe(1);
    expect(overflowEnvironment.watchers.every((watcher) => watcher.isClosed)).toBe(true);
  });

  it('sends correct SSE headers and keepalive comments, then clears keepalive on close', async () => {
    temp = makeTempDir();
    persistBundle(temp.dir);
    const environment = new FakeEnvironment();
    const response = makeStreamResponse();
    const request = streamRequest();
    await handleReviewStream(
      request as unknown as IncomingMessage,
      response.res as unknown as ServerResponse,
      temp.dir,
      REFERENCE,
      environment,
    );
    expect(response.res.headers).toMatchObject({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    environment.runInterval(25_000);
    expect(response.chunks.at(-1)).toBe(': keepalive\n\n');
    request.emit('close');
    expect(environment.intervals).toHaveLength(0);
  });

  it('maps typed missing and corrupt failures before SSE headers are committed', async () => {
    temp = makeTempDir();
    const missingResponse = makeMockRes();
    const environment = new FakeEnvironment();
    await handleReviewStream(
      streamRequest() as unknown as IncomingMessage,
      missingResponse.res as ServerResponse,
      temp.dir,
      REFERENCE,
      environment,
    );
    expect(missingResponse.result()).toMatchObject({
      statusCode: 404,
      headers: { 'Content-Type': 'application/json' },
      json: { error: 'review_not_found' },
    });

    persistBundle(temp.dir);
    writeFileSync(
      `${temp.dir}/.synergy/reviews/${REFERENCE.workspaceId}/workspace.json`,
      '{malformed',
    );
    const corruptResponse = makeMockRes();
    await handleReviewStream(
      streamRequest() as unknown as IncomingMessage,
      corruptResponse.res as ServerResponse,
      temp.dir,
      REFERENCE,
      environment,
    );
    expect(corruptResponse.result()).toMatchObject({
      statusCode: 422,
      headers: { 'Content-Type': 'application/json' },
      json: { error: 'review_corrupt' },
    });
  });
});
