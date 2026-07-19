import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { ReviewRoute } from '../src/review/ReviewRoute.js';
import { REVIEW_REFERENCE, makeReviewClient } from './review-ui-fixtures.js';

function renderRoute(path: string, client = makeReviewClient()) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/r/:workspaceId/:revisionId" element={<ReviewRoute client={client} />} />
      </Routes>
    </MemoryRouter>,
  );
  return client;
}

describe('ReviewRoute', () => {
  it('loads a validated review reference and renders its source identity', async () => {
    const client = renderRoute(`/r/${REVIEW_REFERENCE.workspaceId}/${REVIEW_REFERENCE.revisionId}`);
    expect(screen.getByText('Preparing your review…')).toBeVisible();
    expect(await screen.findByRole('heading', { name: 'PR #317 review' })).toBeVisible();
    expect(client.getBundle).toHaveBeenCalledWith(REVIEW_REFERENCE, expect.any(AbortSignal));
    await waitFor(() => expect(client.postActive).toHaveBeenCalledTimes(1));
    fireEvent.focus(window);
    await waitFor(() => expect(client.postActive).toHaveBeenCalledTimes(2));
  });

  it('rejects unsafe route segments before loading review data', () => {
    const client = renderRoute('/r/workspace%20name/revision-a');
    expect(screen.getByRole('heading', { name: 'Invalid review link' })).toBeVisible();
    expect(client.getBundle).not.toHaveBeenCalled();
  });

  it('distinguishes an unknown review from a temporarily unavailable one', async () => {
    renderRoute(
      `/r/${REVIEW_REFERENCE.workspaceId}/${REVIEW_REFERENCE.revisionId}`,
      makeReviewClient(undefined, {
        getBundle: async () => {
          throw new Error('review_not_found');
        },
      }),
    );
    expect(await screen.findByRole('heading', { name: 'Review not found' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled();
  });

  it.each([
    ['review_corrupt', 'Review data is invalid'],
    ['request_failed', 'Review unavailable'],
  ])('shows an explicit state for %s', async (code, heading) => {
    renderRoute(
      `/r/${REVIEW_REFERENCE.workspaceId}/${REVIEW_REFERENCE.revisionId}`,
      makeReviewClient(undefined, {
        getBundle: async () => {
          throw new Error(code);
        },
      }),
    );
    expect(await screen.findByRole('heading', { name: heading })).toBeVisible();
  });
});
