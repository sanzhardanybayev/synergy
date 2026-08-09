import type { ReviewBundle } from '@synergy/review-core';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ReviewProvider } from '../src/review/ReviewProvider.js';
import { ReviewShell } from '../src/review/ReviewShell.js';
import { makeDiffBundle, makeReviewClient } from './review-ui-fixtures.js';

function bundleWithNarrative(): ReviewBundle {
  const base = makeDiffBundle();
  return {
    ...base,
    insights: {
      ...base.insights,
      summary:
        'This PR reshapes the theme tokens used across the app, then adapts the bottom sheets that consume them.',
      groups: [
        {
          id: 'theme',
          label: 'Theme and surfaces',
          intro: 'Start with the token that drives elevation on Android.',
          reviewItemIds: ['hunk-theme'],
        },
        {
          id: 'sheets',
          label: 'Screen and sheet adaptations',
          intro: 'Then see how the bottom sheet reacts to the new surface.',
          reviewItemIds: ['hunk-sheet'],
        },
      ],
    },
  };
}

function bundleWithoutNarrative(): ReviewBundle {
  return makeDiffBundle();
}

function renderReviewWithBundle(bundle: ReviewBundle) {
  const client = makeReviewClient(bundle);
  render(
    <ReviewProvider
      reference={{ workspaceId: bundle.workspace.id, revisionId: bundle.snapshot.revisionId }}
      client={client}
    >
      <ReviewShell />
    </ReviewProvider>,
  );
  return client;
}

describe('walkthrough UI', () => {
  it('renders the summary bar and locks later chapters when narrative is present', async () => {
    renderReviewWithBundle(bundleWithNarrative());
    expect(await screen.findByText('The story of this change')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /reveal all/i })).toHaveLength(1);
    const locked = document.querySelectorAll('.review-chapter--locked');
    expect(locked).toHaveLength(1);
  });

  it('renders todays flat UI when no summary exists', async () => {
    renderReviewWithBundle(bundleWithoutNarrative());
    await screen.findByText('features/plan/PlanCardToggle.tsx');
    expect(screen.queryByText('The story of this change')).not.toBeInTheDocument();
    expect(document.querySelector('.review-chapter--locked')).toBeNull();
    expect(screen.queryByRole('button', { name: /reveal all/i })).not.toBeInTheDocument();
    expect(document.querySelector('.review-chapter-intro')).toBeNull();
    expect(document.querySelector('.review-continue')).toBeNull();
    expect(screen.getByRole('tab', { name: /hunk 1/i })).toBeInTheDocument();
  });

  it('Continue advances to the next chapter and unlocks it', async () => {
    const user = userEvent.setup();
    renderReviewWithBundle(bundleWithNarrative());
    await screen.findByText('The story of this change');
    expect(document.querySelectorAll('.review-chapter--locked')).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: /continue/i }));
    expect(document.querySelector('.review-chapter--locked')).toBeNull();
  });

  it('renders the chapter intro card with the story chip and group intro', async () => {
    renderReviewWithBundle(bundleWithNarrative());
    expect(await screen.findByText('Ch. 1')).toBeInTheDocument();
    expect(
      screen.getByText('Start with the token that drives elevation on Android.'),
    ).toBeInTheDocument();
  });

  it('labels hunk tabs in story order form when the walkthrough is enabled', async () => {
    renderReviewWithBundle(bundleWithNarrative());
    expect(await screen.findByRole('tab', { name: /H1 · L17-17/i })).toBeInTheDocument();
  });

  it('lets a locked chapter be clicked to jump ahead and reveal it', async () => {
    const user = userEvent.setup();
    renderReviewWithBundle(bundleWithNarrative());
    await screen.findByText('The story of this change');
    await user.click(screen.getByRole('button', { name: /screen and sheet adaptations/i }));
    expect(document.querySelector('.review-chapter--locked')).toBeNull();
    expect(await screen.findByText('features/track-meal/EditBottomSheet.tsx')).toBeVisible();
  });
});
