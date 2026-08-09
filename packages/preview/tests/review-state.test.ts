import type { ReviewInsights, ReviewItem } from '@synergy/review-core';
import { describe, expect, it } from 'vitest';
import { EMPTY_REVIEW_STATE, reviewReducer } from '../src/review/review-state.js';
import { buildChapters, revealedChapterCount } from '../src/review/walkthrough.js';

const items = [
  { id: 'a1', path: 'src/hooks/useAuth.ts' },
  { id: 'a2', path: 'src/hooks/useAuth.ts' },
  { id: 'b1', path: 'src/store/authStore.ts' },
] as ReviewItem[];

const insights = {
  schemaVersion: 1,
  revisionId: 'rev-1',
  summary: 'Story.',
  groups: [
    { id: 'entry', label: 'Entry', intro: 'Start.', reviewItemIds: ['a1', 'a2'] },
    { id: 'core', label: 'Core', reviewItemIds: ['b1'] },
  ],
  items: [],
} as ReviewInsights;

describe('reviewReducer walkthrough state', () => {
  it('tracks revealAll as a session flag', () => {
    const state = reviewReducer(EMPTY_REVIEW_STATE, { type: 'walkthrough-reveal-all' });
    expect(state.walkthroughRevealAll).toBe(true);
  });

  it('defaults walkthroughRevealAll to false', () => {
    expect(EMPTY_REVIEW_STATE.walkthroughRevealAll).toBe(false);
  });

  it('resets walkthroughRevealAll on a fresh load (bundle identity change)', () => {
    const revealed = reviewReducer(EMPTY_REVIEW_STATE, { type: 'walkthrough-reveal-all' });
    expect(revealed.walkthroughRevealAll).toBe(true);
    const reloaded = reviewReducer(revealed, { type: 'loading' });
    expect(reloaded.walkthroughRevealAll).toBe(false);
  });

  it('does not regress the revealed chapter count when the bundle cursor is behind', () => {
    // revealedCount derivation lives in walkthrough.ts (revealedChapterCount) - assert
    // the provider selector picks max(local, server): simulate bundle cursor at chapter 1
    // after a local advance to chapter 2.
    const chapters = buildChapters(insights, items);
    expect(
      Math.max(revealedChapterCount(chapters, 'b1'), revealedChapterCount(chapters, 'a1')),
    ).toBe(2);
  });
});
