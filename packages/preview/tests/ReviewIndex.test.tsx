import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { ReviewIndexEntry, ReviewIndexResponse } from '../src/api.js';
import { ReviewIndex } from '../src/review/ReviewIndex.js';

function entry(overrides: Partial<ReviewIndexEntry> = {}): ReviewIndexEntry {
  return {
    workspaceId: 'workspace-a',
    revisionId: 'revision-a',
    subject: 'Staged changes',
    sourceKind: 'staged',
    itemCount: 4,
    reviewedCount: 2,
    openQuestions: 0,
    updatedAt: '2026-08-01T10:00:00.000Z',
    ...overrides,
  };
}

function renderIndex(response: ReviewIndexResponse) {
  const fetchIndex = vi.fn().mockResolvedValue(response);
  render(
    <MemoryRouter>
      <ReviewIndex fetchIndex={fetchIndex} />
    </MemoryRouter>,
  );
  return fetchIndex;
}

describe('ReviewIndex', () => {
  it('renders a card per review with subject, progress, and updated time', async () => {
    renderIndex({
      reviews: [entry({ subject: 'PR #317', sourceKind: 'pr' })],
    });

    expect(await screen.findByText('PR #317')).toBeVisible();
    expect(screen.getByText('2/4 reviewed', { exact: false })).toBeVisible();
    const progress = screen.getByRole('progressbar') as HTMLProgressElement;
    expect(progress.value).toBe(2);
    expect(progress.max).toBe(4);
  });

  it('links each card to the workspace review route', async () => {
    renderIndex({ reviews: [entry()] });

    const link = await screen.findByRole('link');
    expect(link).toHaveAttribute('href', '/r/workspace-a/revision-a');
  });

  it('shows the Complete badge only when fully reviewed', async () => {
    renderIndex({
      reviews: [entry({ workspaceId: 'w-complete', reviewedCount: 3, itemCount: 3 })],
    });

    expect(await screen.findByText('Complete')).toBeVisible();
  });

  it('shows an open-question badge when questions are queued or processing', async () => {
    renderIndex({ reviews: [entry({ openQuestions: 2 })] });

    expect(await screen.findByText('2 questions')).toBeVisible();
  });

  it('shows an Unreadable badge for degraded workspaces and skips the navigable link', async () => {
    renderIndex({
      reviews: [
        entry({
          workspaceId: 'workspace-corrupt',
          revisionId: '',
          subject: 'workspace-corrupt',
          itemCount: 0,
          reviewedCount: 0,
          degraded: 'invalid_json',
        }),
      ],
    });

    expect(await screen.findByText('Unreadable')).toBeVisible();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('shows an empty state when there are no reviews', async () => {
    renderIndex({ reviews: [] });

    expect(await screen.findByText('No review sessions yet.')).toBeVisible();
  });
});
