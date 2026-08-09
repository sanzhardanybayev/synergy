import type {
  ReviewAnswer,
  ReviewBundle,
  ReviewQuestion,
  ReviewReadiness,
  ReviewRef,
} from '@synergy/review-core';
import { deriveReviewReadiness } from '@synergy/review-core';
import { resolveBrowserReviewItemContext } from '@synergy/review-core/browser';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type ReviewClient,
  ReviewProvider,
  type ReviewStreamHandlers,
  useReview,
} from '../src/review/ReviewProvider.js';

const REFERENCE: ReviewRef = { workspaceId: 'workspace-a', revisionId: 'revision-a' };

function bundle(overrides: Partial<ReviewBundle> = {}): ReviewBundle {
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
          range: { start: 1, end: 1 },
          contentHash: 'content-a',
          locationHash: 'location-a',
        },
        {
          id: 'hunk-b',
          kind: 'code-section',
          path: 'src/example.ts',
          label: 'example two',
          range: { start: 2, end: 2 },
          contentHash: 'content-b',
          locationHash: 'location-b',
        },
      ],
    },
    insights: {
      schemaVersion: 1,
      revisionId: REFERENCE.revisionId,
      groups: [{ id: 'group-a', label: 'Example', reviewItemIds: ['hunk-a', 'hunk-b'] }],
      items: [],
    },
    progress: {
      schemaVersion: 1,
      updatedAt: '2026-07-19T10:00:00.000Z',
      items: {
        'hunk-a': { status: 'needs-review' },
        'hunk-b': { status: 'needs-review' },
      },
    },
    questions: [],
    answers: [],
    sourceChanged: false,
    ...overrides,
  };
}

function readiness(input: Partial<ReviewReadiness> = {}): ReviewReadiness {
  return {
    ready: false,
    preparing: false,
    pending: 2,
    stale: 0,
    unanswered: 0,
    sourceChanged: false,
    ...input,
  };
}

function response(input: ReviewBundle = bundle()): {
  bundle: ReviewBundle;
  readiness: ReviewReadiness;
  analysisFinalized: boolean;
} {
  return { bundle: input, readiness: readiness(), analysisFinalized: true };
}

function createClient(overrides: Partial<ReviewClient> = {}): ReviewClient {
  return {
    getBundle: vi.fn().mockResolvedValue(response()),
    patchProgress: vi.fn().mockResolvedValue(response()),
    postQuestion: vi.fn().mockResolvedValue({ question: question(), ...response() }),
    postActive: vi.fn().mockResolvedValue(undefined),
    patchWalkthrough: vi.fn().mockResolvedValue(response()),
    openStream: vi.fn().mockReturnValue({ close: vi.fn() }),
    ...overrides,
  };
}

function question(overrides: Partial<ReviewQuestion> = {}): ReviewQuestion {
  return {
    schemaVersion: 1,
    id: 'question-a',
    workspaceId: REFERENCE.workspaceId,
    revisionId: REFERENCE.revisionId,
    path: 'src/example.ts',
    reviewItemId: 'hunk-a',
    selection: { kind: 'scope', selectedLineIds: [ROW_ONE] },
    itemContext: { item: bundle().snapshot.items[0]!, rows: [] },
    description: '',
    body: 'Why?',
    createdAt: '2026-07-19T10:00:00.000Z',
    generation: 0,
    status: 'queued',
    ...overrides,
  };
}

function answer(overrides: Partial<ReviewAnswer> = {}): ReviewAnswer {
  return {
    schemaVersion: 1,
    id: 'answer-a',
    questionId: 'question-a',
    workspaceId: REFERENCE.workspaceId,
    revisionId: REFERENCE.revisionId,
    listenerId: 'listener-a',
    body: 'First durable answer.',
    createdAt: '2026-07-19T10:00:00.000Z',
    ...overrides,
  };
}

const ROW_ONE = resolveBrowserReviewItemContext(bundle().snapshot, 'hunk-a').rows[0]!.id;

function Probe() {
  const review = useReview();
  const current = review.bundle?.progress.items['hunk-a']?.status;
  return (
    <>
      <output>{current === 'reviewed' ? '1 of 2 reviewed' : '0 of 2 reviewed'}</output>
      <button type="button" onClick={() => void review.markProgress('hunk-a', 'reviewed')}>
        Mark reviewed
      </button>
      <button type="button" onClick={() => review.setActiveItem('hunk-b')}>
        Open second item
      </button>
      <button type="button" onClick={() => review.toggleSelectedLine(ROW_ONE)}>
        Select line one
      </button>
      <output data-testid="selection">{review.selectedLineIds.join(',')}</output>
      {review.error ? <p role="alert">{review.error}</p> : null}
    </>
  );
}

function QuestionProbe() {
  const review = useReview();
  return (
    <>
      <input
        aria-label="Question draft"
        value={review.questionDraft}
        onChange={(event) => review.setQuestionDraft(event.target.value)}
      />
      <button type="button" onClick={() => review.toggleSelectedLine(ROW_ONE)}>
        Select line
      </button>
      <button type="button" onClick={() => void review.sendQuestion()}>
        Send question
      </button>
      <output data-testid="selection">{review.selectedLineIds.join(',')}</output>
      {review.error ? <p role="alert">{review.error}</p> : null}
    </>
  );
}

function RetryProbe() {
  const review = useReview();
  if (review.status === 'loading') return <p>Loading</p>;
  if (review.status === 'error') {
    return (
      <>
        <p role="alert">{review.error}</p>
        <button type="button" onClick={() => void review.retry()}>
          Retry
        </button>
      </>
    );
  }
  return <p>Ready</p>;
}

afterEach(() => vi.restoreAllMocks());

describe('ReviewProvider', () => {
  it('retains a note edit made while an earlier note save is pending', async () => {
    let resolveSave:
      | ((value: { bundle: ReviewBundle; readiness: ReviewReadiness }) => void)
      | undefined;
    const client = createClient({
      patchProgress: vi.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveSave = resolve;
          }),
      ),
    });
    let review: ReturnType<typeof useReview> | undefined;
    function Capture() {
      review = useReview();
      return null;
    }
    render(
      <ReviewProvider reference={REFERENCE} client={client}>
        <Capture />
      </ReviewProvider>,
    );
    await waitFor(() => expect(review?.status).toBe('ready'));
    act(() => review?.setNoteDraft('hunk-a', 'first'));
    await act(async () => {
      void review?.saveNote('hunk-a');
    });
    act(() => review?.setNoteDraft('hunk-a', 'newer edit'));
    await act(async () => resolveSave?.(response()));
    expect(review?.noteDrafts['hunk-a']).toBe('newer edit');
  });

  it('keeps the newer progress bundle when concurrent mutations resolve in reverse order', async () => {
    const resolvers: Array<(value: { bundle: ReviewBundle; readiness: ReviewReadiness }) => void> =
      [];
    const client = createClient({
      patchProgress: vi.fn().mockImplementation(
        () =>
          new Promise(
            (resolve: (value: { bundle: ReviewBundle; readiness: ReviewReadiness }) => void) => {
              resolvers.push(resolve);
            },
          ),
      ),
    });
    let review: ReturnType<typeof useReview> | undefined;
    function Capture() {
      review = useReview();
      return null;
    }
    render(
      <ReviewProvider reference={REFERENCE} client={client}>
        <Capture />
      </ReviewProvider>,
    );
    await waitFor(() => expect(review?.status).toBe('ready'));
    await act(async () => {
      void review?.markProgress('hunk-a', 'reviewed');
      void review?.markProgress('hunk-b', 'reviewed');
    });
    await act(async () =>
      resolvers[1]?.(
        response(
          bundle({
            progress: {
              ...bundle().progress,
              updatedAt: '2026-07-19T10:00:02.000Z',
              items: {
                'hunk-a': { status: 'needs-review' },
                'hunk-b': { status: 'reviewed' },
              },
            },
          }),
        ),
      ),
    );
    await act(async () =>
      resolvers[0]?.(
        response(
          bundle({
            progress: {
              ...bundle().progress,
              updatedAt: '2026-07-19T10:00:01.000Z',
              items: {
                'hunk-a': { status: 'reviewed' },
                'hunk-b': { status: 'needs-review' },
              },
            },
          }),
        ),
      ),
    );
    expect(review?.bundle?.progress).toMatchObject({
      updatedAt: '2026-07-19T10:00:02.000Z',
      items: { 'hunk-b': { status: 'reviewed' } },
    });
  });

  it('retains question draft and exact selection edited while the question is pending', async () => {
    let resolveQuestion:
      | ((value: ReturnType<typeof response> & { question: ReviewQuestion }) => void)
      | undefined;
    const client = createClient({
      postQuestion: vi.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveQuestion = resolve;
          }),
      ),
    });
    let review: ReturnType<typeof useReview> | undefined;
    function Capture() {
      review = useReview();
      return null;
    }
    render(
      <ReviewProvider reference={REFERENCE} client={client}>
        <Capture />
      </ReviewProvider>,
    );
    await waitFor(() => expect(review?.status).toBe('ready'));
    act(() => {
      review?.toggleSelectedLine(ROW_ONE);
      review?.setQuestionDraft('first');
    });
    await act(async () => {
      void review?.sendQuestion();
    });
    act(() => {
      review?.setQuestionDraft('newer');
      review?.toggleSelectedLine(ROW_ONE);
    });
    await act(async () => resolveQuestion?.({ question: question(), ...response() }));
    expect(review?.questionDraft).toBe('newer');
    expect(review?.selectedLineIds).toEqual([]);
  });
  it('updates a checkbox only after the progress request succeeds', async () => {
    let resolvePatch:
      | ((value: { bundle: ReviewBundle; readiness: ReviewReadiness }) => void)
      | undefined;
    const client = createClient({
      patchProgress: vi.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            resolvePatch = resolve;
          }),
      ),
    });
    const user = userEvent.setup();
    render(
      <ReviewProvider reference={REFERENCE} client={client}>
        <Probe />
      </ReviewProvider>,
    );

    await user.click(await screen.findByRole('button', { name: 'Mark reviewed' }));
    expect(screen.getByText('0 of 2 reviewed')).toBeVisible();
    expect(client.patchProgress).toHaveBeenCalledWith(
      REFERENCE,
      'hunk-a',
      { status: 'reviewed' },
      expect.any(AbortSignal),
    );

    await act(async () => {
      resolvePatch?.(
        response(
          bundle({
            progress: {
              ...bundle().progress,
              updatedAt: '2026-07-19T10:00:01.000Z',
              items: { ...bundle().progress.items, 'hunk-a': { status: 'reviewed' } },
            },
          }),
        ),
      );
    });
    expect(await screen.findByText('1 of 2 reviewed')).toBeVisible();
  });

  it('keeps a failed question draft and reports the error', async () => {
    const client = createClient({
      postQuestion: vi.fn().mockRejectedValue(new Error('disk full')),
    });
    const user = userEvent.setup();
    render(
      <ReviewProvider reference={REFERENCE} client={client}>
        <QuestionProbe />
      </ReviewProvider>,
    );
    await screen.findByRole('textbox', { name: 'Question draft' });
    await user.click(screen.getByRole('button', { name: 'Select line' }));
    await user.type(screen.getByRole('textbox', { name: 'Question draft' }), 'Explain this');
    await user.click(screen.getByRole('button', { name: 'Send question' }));

    expect(screen.getByRole('textbox', { name: 'Question draft' })).toHaveValue('Explain this');
    expect(await screen.findByText('Could not queue question: disk full')).toBeVisible();
    expect(screen.getByTestId('selection')).toHaveTextContent(ROW_ONE);
  });

  it('retries the initial load after a sanitized failure', async () => {
    const client = createClient({
      getBundle: vi
        .fn()
        .mockRejectedValueOnce(new Error('review_not_found'))
        .mockResolvedValue(response()),
    });
    const user = userEvent.setup();
    render(
      <ReviewProvider reference={REFERENCE} client={client}>
        <RetryProbe />
      </ReviewProvider>,
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not load review: review_not_found',
    );
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Ready')).toBeVisible();
  });

  it('remains operable after the Strict Mode effect replay without duplicate activation', async () => {
    const client = createClient();
    render(
      <StrictMode>
        <ReviewProvider reference={REFERENCE} client={client}>
          <RetryProbe />
        </ReviewProvider>
      </StrictMode>,
    );

    expect(await screen.findByText('Ready')).toBeVisible();
    await waitFor(() => expect(client.postActive).toHaveBeenCalledTimes(1));
  });

  it('saves note-only updates and retains the draft when a clear fails', async () => {
    const patchProgress = vi
      .fn()
      .mockResolvedValueOnce(
        response(
          bundle({
            progress: {
              ...bundle().progress,
              items: {
                ...bundle().progress.items,
                'hunk-a': { status: 'needs-review', note: 'Keep this' },
              },
            },
          }),
        ),
      )
      .mockRejectedValueOnce(new Error('offline'));
    const client = createClient({ patchProgress });
    let review: ReturnType<typeof useReview> | undefined;
    function Capture() {
      review = useReview();
      return null;
    }
    render(
      <ReviewProvider reference={REFERENCE} client={client}>
        <Capture />
      </ReviewProvider>,
    );
    await waitFor(() => expect(review?.status).toBe('ready'));
    act(() => review?.setNoteDraft('hunk-a', 'Keep this'));
    await act(async () => review?.saveNote('hunk-a'));
    expect(patchProgress).toHaveBeenNthCalledWith(
      1,
      REFERENCE,
      'hunk-a',
      { note: 'Keep this' },
      expect.any(AbortSignal),
    );
    expect(review?.noteDrafts['hunk-a']).toBeUndefined();
    act(() => review?.setNoteDraft('hunk-a', ''));
    await act(async () => review?.saveNote('hunk-a'));
    expect(patchProgress).toHaveBeenNthCalledWith(
      2,
      REFERENCE,
      'hunk-a',
      { note: null },
      expect.any(AbortSignal),
    );
    expect(review?.noteDrafts['hunk-a']).toBe('');
  });

  it('clears an exact line selection when the active item changes', async () => {
    const client = createClient();
    const user = userEvent.setup();
    render(
      <ReviewProvider reference={REFERENCE} client={client}>
        <Probe />
      </ReviewProvider>,
    );
    await screen.findByRole('button', { name: 'Select line one' });
    await user.click(screen.getByRole('button', { name: 'Select line one' }));
    expect(screen.getByTestId('selection')).toHaveTextContent(ROW_ONE);
    await user.click(screen.getByRole('button', { name: 'Open second item' }));
    expect(screen.getByTestId('selection')).toBeEmptyDOMElement();
  });

  it('applies duplicate stream records once and ignores older progress frames', async () => {
    let handlers: ReviewStreamHandlers | undefined;
    const client = createClient({
      openStream: vi
        .fn()
        .mockImplementation((_reference: ReviewRef, next: ReviewStreamHandlers) => {
          handlers = next;
          return { close: vi.fn() };
        }),
    });
    let review: ReturnType<typeof useReview> | undefined;
    function Capture() {
      review = useReview();
      return <output>{review.bundle?.questions.length}</output>;
    }
    render(
      <ReviewProvider reference={REFERENCE} client={client}>
        <Capture />
      </ReviewProvider>,
    );
    await waitFor(() => expect(handlers).toBeDefined());
    const queued = question();
    act(() => {
      handlers?.onFrame({ type: 'question', question: queued }, 'question:question-a:one');
      handlers?.onFrame({ type: 'question', question: queued }, 'question:question-a:one');
      handlers?.onFrame(
        {
          type: 'progress',
          progress: { ...bundle().progress, updatedAt: '2026-07-19T11:00:00.000Z' },
          readiness: readiness(),
          analysisFinalized: true,
        },
        'progress:new',
      );
      handlers?.onFrame(
        {
          type: 'progress',
          progress: { ...bundle().progress, updatedAt: '2026-07-19T09:00:00.000Z' },
          readiness: readiness(),
          analysisFinalized: true,
        },
        'progress:old',
      );
    });
    expect(review?.bundle?.questions).toEqual([queued]);
    expect(review?.bundle?.progress.updatedAt).toBe('2026-07-19T11:00:00.000Z');
    expect(review?.readiness).toMatchObject({ pending: 2, unanswered: 1, ready: false });
  });

  it('reloads the atomic finalized scope bundle when an open preparing stream finalizes', async () => {
    let handlers: ReviewStreamHandlers | undefined;
    const pending = bundle();
    if (pending.snapshot.kind !== 'scope') throw new Error('expected scoped fixture');
    pending.snapshot.items = [];
    pending.insights.groups = [];
    pending.progress.items = {};
    const finalized = bundle();
    const getBundle = vi
      .fn()
      .mockResolvedValueOnce({
        bundle: pending,
        readiness: deriveReviewReadiness(pending, false),
        analysisFinalized: false,
      })
      .mockResolvedValueOnce({
        bundle: finalized,
        readiness: deriveReviewReadiness(finalized, true),
        analysisFinalized: true,
      });
    const client = createClient({
      getBundle,
      openStream: vi
        .fn()
        .mockImplementation((_reference: ReviewRef, next: ReviewStreamHandlers) => {
          handlers = next;
          return { close: vi.fn() };
        }),
    });
    let review: ReturnType<typeof useReview> | undefined;
    function Capture() {
      review = useReview();
      return <output>{review.bundle?.snapshot.items.length}</output>;
    }
    render(
      <ReviewProvider reference={REFERENCE} client={client}>
        <Capture />
      </ReviewProvider>,
    );
    await waitFor(() => expect(handlers).toBeDefined());
    expect(review?.analysisFinalized).toBe(false);

    act(() =>
      handlers?.onFrame(
        {
          type: 'progress',
          progress: finalized.progress,
          readiness: deriveReviewReadiness(finalized, true),
          analysisFinalized: true,
        },
        'progress:finalized',
      ),
    );

    await waitFor(() => expect(getBundle).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(review?.analysisFinalized).toBe(true));
    expect(review?.bundle?.snapshot.items).toEqual(finalized.snapshot.items);
  });

  it('does not let a late HTTP bundle roll back an authoritative source frame', async () => {
    let handlers: ReviewStreamHandlers | undefined;
    const client = createClient({
      openStream: vi
        .fn()
        .mockImplementation((_reference: ReviewRef, next: ReviewStreamHandlers) => {
          handlers = next;
          return { close: vi.fn() };
        }),
      patchProgress: vi.fn().mockResolvedValue(response()),
    });
    let review: ReturnType<typeof useReview> | undefined;
    function Capture() {
      review = useReview();
      return null;
    }
    render(
      <ReviewProvider reference={REFERENCE} client={client}>
        <Capture />
      </ReviewProvider>,
    );
    await waitFor(() => expect(handlers).toBeDefined());
    act(() =>
      handlers?.onFrame({ type: 'source', changed: true, captureFailed: false }, 'source:1'),
    );
    await act(async () => review?.markProgress('hunk-a', 'reviewed'));
    expect(review?.bundle?.sourceChanged).toBe(true);
    expect(review?.readiness?.sourceChanged).toBe(true);
  });

  it('preserves the first durable answer when a duplicate SSE answer conflicts', async () => {
    let handlers: ReviewStreamHandlers | undefined;
    const client = createClient({
      openStream: vi
        .fn()
        .mockImplementation((_reference: ReviewRef, next: ReviewStreamHandlers) => {
          handlers = next;
          return { close: vi.fn() };
        }),
    });
    let review: ReturnType<typeof useReview> | undefined;
    function Capture() {
      review = useReview();
      return null;
    }
    render(
      <ReviewProvider reference={REFERENCE} client={client}>
        <Capture />
      </ReviewProvider>,
    );
    await waitFor(() => expect(handlers).toBeDefined());
    const first = answer();
    act(() => {
      handlers?.onFrame({ type: 'answer', answer: first }, 'answer:one');
      handlers?.onFrame(
        { type: 'answer', answer: answer({ body: 'Conflicting replacement.' }) },
        'answer:two',
      );
    });
    expect(review?.bundle?.answers).toEqual([first]);
  });

  it('recovers source capture status only from a healthy authoritative source frame', async () => {
    let handlers: ReviewStreamHandlers | undefined;
    const client = createClient({
      openStream: vi
        .fn()
        .mockImplementation((_reference: ReviewRef, next: ReviewStreamHandlers) => {
          handlers = next;
          return { close: vi.fn() };
        }),
    });
    let review: ReturnType<typeof useReview> | undefined;
    function Capture() {
      review = useReview();
      return null;
    }
    render(
      <ReviewProvider reference={REFERENCE} client={client}>
        <Capture />
      </ReviewProvider>,
    );
    await waitFor(() => expect(handlers).toBeDefined());
    act(() => {
      handlers?.onOpen?.();
      handlers?.onFrame(
        { type: 'interruption', code: 'source_capture_failed', recoverable: true },
        'interruption:source',
      );
      handlers?.onFrame({ type: 'presence', listening: true }, 'presence:one');
    });
    expect(review).toMatchObject({
      streamStatus: 'connected',
      interruptionCode: 'source_capture_failed',
      captureFailed: true,
    });
    act(() =>
      handlers?.onFrame(
        { type: 'source', changed: false, captureFailed: false },
        'source:recovered',
      ),
    );
    expect(review).toMatchObject({
      streamStatus: 'connected',
      interruptionCode: null,
      captureFailed: false,
    });
  });

  it('ignores a late request after its reference changes', async () => {
    let resolveFirst:
      | ((value: { bundle: ReviewBundle; readiness: ReviewReadiness }) => void)
      | undefined;
    const close = vi.fn();
    const client = createClient({
      getBundle: vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveFirst = resolve;
            }),
        )
        .mockResolvedValue(response()),
      openStream: vi.fn().mockReturnValue({ close }),
    });
    const { rerender } = render(
      <ReviewProvider reference={REFERENCE} client={client}>
        <RetryProbe />
      </ReviewProvider>,
    );
    const next = { workspaceId: 'workspace-b', revisionId: 'revision-b' };
    rerender(
      <ReviewProvider reference={next} client={client}>
        <RetryProbe />
      </ReviewProvider>,
    );
    await screen.findByText('Ready');
    await act(async () => resolveFirst?.(response()));
    expect(close).not.toHaveBeenCalled();
    expect(client.openStream).toHaveBeenCalledTimes(1);
  });

  it('closes its one stream when unmounted', async () => {
    const close = vi.fn();
    const client = createClient({ openStream: vi.fn().mockReturnValue({ close }) });
    const view = render(
      <ReviewProvider reference={REFERENCE} client={client}>
        <RetryProbe />
      </ReviewProvider>,
    );
    await screen.findByText('Ready');
    view.unmount();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('aborts a pending mutation on unmount without dispatching a late failure', async () => {
    let rejectPatch: ((reason: Error) => void) | undefined;
    const client = createClient({
      patchProgress: vi.fn().mockImplementation(
        () =>
          new Promise((_, reject: (reason: Error) => void) => {
            rejectPatch = reject;
          }),
      ),
    });
    let review: ReturnType<typeof useReview> | undefined;
    function Capture() {
      review = useReview();
      return null;
    }
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const view = render(
      <ReviewProvider reference={REFERENCE} client={client}>
        <Capture />
      </ReviewProvider>,
    );
    await waitFor(() => expect(review?.status).toBe('ready'));
    await act(async () => {
      void review?.markProgress('hunk-a', 'reviewed');
    });
    view.unmount();
    await act(async () => rejectPatch?.(new Error('late failure')));
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('does not reload or reopen for an equivalent reference object', async () => {
    const client = createClient();
    const view = render(
      <ReviewProvider reference={{ ...REFERENCE }} client={client}>
        <RetryProbe />
      </ReviewProvider>,
    );
    await screen.findByText('Ready');
    view.rerender(
      <ReviewProvider reference={{ ...REFERENCE }} client={client}>
        <RetryProbe />
      </ReviewProvider>,
    );
    await waitFor(() => expect(client.getBundle).toHaveBeenCalledTimes(1));
    expect(client.openStream).toHaveBeenCalledTimes(1);
  });

  it('caps brief open-error stream reconnects at eight instances and clears timers on unmount', async () => {
    vi.useFakeTimers();
    try {
      const handlers: ReviewStreamHandlers[] = [];
      const client = createClient({
        openStream: vi
          .fn()
          .mockImplementation((_reference: ReviewRef, next: ReviewStreamHandlers) => {
            handlers.push(next);
            return { close: vi.fn() };
          }),
      });
      const view = render(
        <ReviewProvider reference={REFERENCE} client={client}>
          <RetryProbe />
        </ReviewProvider>,
      );
      await act(async () => {
        await Promise.resolve();
      });
      expect(client.openStream).toHaveBeenCalledTimes(1);

      for (let index = 0; index < 8; index += 1) {
        act(() => handlers[index]?.onOpen?.());
        act(() => handlers[index]?.onError?.());
        await act(async () => {
          await vi.advanceTimersByTimeAsync(4_000);
        });
      }
      expect(client.openStream).toHaveBeenCalledTimes(8);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(20_000);
      });
      expect(client.openStream).toHaveBeenCalledTimes(8);
      view.unmount();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('resets the reconnect budget only after a five-second stable open window', async () => {
    vi.useFakeTimers();
    try {
      const handlers: ReviewStreamHandlers[] = [];
      const client = createClient({
        openStream: vi
          .fn()
          .mockImplementation((_reference: ReviewRef, next: ReviewStreamHandlers) => {
            handlers.push(next);
            return { close: vi.fn() };
          }),
      });
      const view = render(
        <ReviewProvider reference={REFERENCE} client={client}>
          <RetryProbe />
        </ReviewProvider>,
      );
      await act(async () => {
        await Promise.resolve();
      });
      for (let index = 0; index < 7; index += 1) {
        act(() => handlers[index]?.onError?.());
        await act(async () => {
          await vi.advanceTimersByTimeAsync(4_000);
        });
      }
      expect(client.openStream).toHaveBeenCalledTimes(8);
      act(() => handlers[7]?.onOpen?.());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      act(() => handlers[7]?.onError?.());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(250);
      });
      expect(client.openStream).toHaveBeenCalledTimes(9);
      view.unmount();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('matches authoritative readiness for mixed needs-review and stale progress', async () => {
    const mixed = bundle({
      progress: {
        ...bundle().progress,
        items: {
          'hunk-a': { status: 'stale' },
          'hunk-b': { status: 'needs-review' },
        },
      },
    });
    const client = createClient({
      getBundle: vi
        .fn()
        .mockResolvedValue({ bundle: mixed, readiness: deriveReviewReadiness(mixed) }),
    });
    let review: ReturnType<typeof useReview> | undefined;
    function Capture() {
      review = useReview();
      return null;
    }
    render(
      <ReviewProvider reference={REFERENCE} client={client}>
        <Capture />
      </ReviewProvider>,
    );
    await waitFor(() => expect(review?.status).toBe('ready'));
    expect(review?.readiness).toEqual(deriveReviewReadiness(mixed));
  });

  it('surfaces feedback when a caller tries to select a noncanonical source row', async () => {
    const client = createClient();
    let review: ReturnType<typeof useReview> | undefined;
    function Capture() {
      review = useReview();
      return null;
    }
    render(
      <ReviewProvider reference={REFERENCE} client={client}>
        <Capture />
      </ReviewProvider>,
    );
    await waitFor(() => expect(review?.status).toBe('ready'));
    act(() => review?.toggleSelectedLine('row-not-canonical'));
    expect(review?.error).toBe('Selected source row is no longer available');
  });
});
