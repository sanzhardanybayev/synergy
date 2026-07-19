import type { ReviewAnswer, ReviewQuestion } from '@synergy/review-core';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ReviewProvider, type ReviewStreamHandlers } from '../src/review/ReviewProvider.js';
import { ReviewShell } from '../src/review/ReviewShell.js';
import {
  REVIEW_REFERENCE,
  firstDiffRowId,
  makeDiffBundle,
  makeReviewClient,
} from './review-ui-fixtures.js';

function renderRail(bundle = makeDiffBundle(), client = makeReviewClient(bundle)) {
  render(
    <ReviewProvider reference={REVIEW_REFERENCE} client={client}>
      <ReviewShell />
    </ReviewProvider>,
  );
  return client;
}

function question(
  status: ReviewQuestion['status'],
  overrides: Partial<ReviewQuestion> = {},
): ReviewQuestion {
  const bundle = makeDiffBundle();
  const item = bundle.snapshot.items[0]!;
  return {
    schemaVersion: 1,
    id: `question-${status}`,
    workspaceId: REVIEW_REFERENCE.workspaceId,
    revisionId: REVIEW_REFERENCE.revisionId,
    path: item.path,
    reviewItemId: item.id,
    selection: { kind: 'diff', selectedLineIds: [firstDiffRowId()] },
    itemContext: { item, rows: [] },
    description: bundle.insights.items[0]!.description,
    body: `Question in ${status}`,
    createdAt: '2026-07-19T10:00:00.000Z',
    generation: status === 'queued' ? 0 : 1,
    status,
    ...overrides,
  };
}

describe('QuestionRail', () => {
  it('shows durable question states and persisted answers', async () => {
    const answered = question('answered');
    const answer: ReviewAnswer = {
      schemaVersion: 1,
      id: 'answer-a',
      questionId: answered.id,
      workspaceId: REVIEW_REFERENCE.workspaceId,
      revisionId: REVIEW_REFERENCE.revisionId,
      listenerId: 'agent-a',
      body: 'The surface token is theme-aware and preserves Android elevation.',
      createdAt: '2026-07-19T10:01:00.000Z',
    };
    const bundle = makeDiffBundle({
      questions: [question('queued'), question('processing'), answered, question('failed')],
      answers: [answer],
    });
    renderRail(bundle);
    expect(await screen.findByText('Question queued')).toBeVisible();
    expect(screen.getByText('Processing')).toBeVisible();
    expect(screen.getByText('Answered')).toBeVisible();
    expect(screen.getByText('Failed — retryable')).toBeVisible();
    expect(screen.getByText(answer.body)).toBeVisible();
  });

  it('lists only concrete readiness blockers and reports source drift', async () => {
    const bundle = makeDiffBundle({
      progress: {
        schemaVersion: 1,
        updatedAt: '2026-07-19T10:00:01.000Z',
        items: {
          'hunk-theme': { status: 'stale' },
          'hunk-sheet': { status: 'needs-review' },
        },
      },
      questions: [question('queued')],
      sourceChanged: true,
    });
    renderRail(bundle);
    expect(await screen.findByText('1 item still needs review')).toBeVisible();
    expect(screen.getByText('1 stale item needs another look')).toBeVisible();
    expect(screen.getByText('1 question is waiting for an answer')).toBeVisible();
    expect(screen.getByText('Source changed — refresh to reconcile a new revision')).toBeVisible();
    expect(screen.queryByText(/evidence/i)).not.toBeInTheDocument();
  });

  it('shows agent and connection visibility without implying an answer', async () => {
    renderRail();
    expect(await screen.findByText('Not listening')).toBeVisible();
    expect(screen.getByText('Connecting to agent…')).toBeVisible();
  });

  it('keeps transport and source verification truthful through disconnect and recovery', async () => {
    const streamHandlers: ReviewStreamHandlers[] = [];
    const readyBundle = makeDiffBundle({
      progress: {
        schemaVersion: 1,
        updatedAt: '2026-07-19T10:00:01.000Z',
        items: {
          'hunk-theme': { status: 'reviewed' },
          'hunk-sheet': { status: 'reviewed' },
        },
      },
    });
    const client = makeReviewClient(readyBundle, {
      openStream: (_reference, nextHandlers) => {
        streamHandlers.push(nextHandlers);
        return { close: () => undefined };
      },
    });
    renderRail(readyBundle, client);
    expect(await screen.findByText('Ready to finish')).toBeVisible();
    await waitFor(() => expect(streamHandlers).toHaveLength(1));

    act(() => {
      streamHandlers[0]?.onOpen?.();
      streamHandlers[0]?.onFrame({ type: 'presence', listening: true }, 'presence-listening');
    });
    expect(screen.getByText('Connected')).toBeVisible();
    expect(screen.getByText('Listening')).toBeVisible();

    act(() => {
      streamHandlers[0]?.onFrame(
        {
          type: 'interruption',
          code: 'source_capture_failed',
          recoverable: true,
        },
        'capture-failed',
      );
    });
    expect(screen.getByText('Unverified')).toBeVisible();
    expect(screen.queryByText('Ready to finish')).not.toBeInTheDocument();
    expect(
      screen.getByText('Source freshness could not be verified — restore capture before finishing'),
    ).toBeVisible();
    expect(screen.getByText('Source verification unavailable')).toBeVisible();
    expect(screen.getByText('Connected')).toBeVisible();

    act(() => streamHandlers[0]?.onError?.());
    expect(screen.getByText('Connection interrupted')).toBeVisible();
    expect(screen.getByText('Not listening')).toBeVisible();
    expect(screen.getByText('Source verification unavailable')).toBeVisible();

    await waitFor(() => expect(streamHandlers).toHaveLength(2));
    act(() => streamHandlers[1]?.onOpen?.());
    expect(screen.getByText('Connected')).toBeVisible();
    expect(screen.getByText('Not listening')).toBeVisible();
    expect(screen.getByText('Unverified')).toBeVisible();
    expect(screen.queryByText('Ready to finish')).not.toBeInTheDocument();

    act(() => {
      streamHandlers[1]?.onFrame(
        { type: 'source', changed: false, captureFailed: false },
        'capture-recovered',
      );
    });
    expect(screen.getByText('Current')).toBeVisible();
    expect(screen.getByText('Ready to finish')).toBeVisible();
    expect(screen.queryByText('Source verification unavailable')).not.toBeInTheDocument();
  });

  it('orders questions newest-first by timestamp and stable ID after every reload', async () => {
    const questions = [
      question('queued', {
        id: 'zzz-old',
        body: 'Order old',
        createdAt: '2026-07-19T10:00:00.000Z',
      }),
      question('queued', {
        id: 'bbb-tie',
        body: 'Order tie B',
        createdAt: '2026-07-19T11:00:00.000Z',
      }),
      question('queued', {
        id: 'aaa-new',
        body: 'Order newest',
        createdAt: '2026-07-19T12:00:00.000Z',
      }),
      question('queued', {
        id: 'aaa-tie',
        body: 'Order tie A',
        createdAt: '2026-07-19T11:00:00.000Z',
      }),
    ];
    const expected = ['Order newest', 'Order tie A', 'Order tie B', 'Order old'];
    const readOrder = (): string[] =>
      screen
        .getAllByRole('article')
        .map((article) => within(article).getByText(/^Order/u).textContent ?? '');

    renderRail(makeDiffBundle({ questions }));
    await screen.findByText('Order newest');
    expect(readOrder()).toEqual(expected);
    cleanup();
    renderRail(makeDiffBundle({ questions: [...questions].reverse() }));
    await screen.findByText('Order newest');
    expect(readOrder()).toEqual(expected);
  });
});
