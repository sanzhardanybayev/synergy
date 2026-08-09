import type { ReviewInsights, ReviewItem } from '@synergy/review-core';
import { describe, expect, it } from 'vitest';
import {
  buildChapters,
  chapterOf,
  nextPosition,
  revealedChapterCount,
  storyIndexOf,
  walkthroughEnabled,
} from '../src/review/walkthrough.js';

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

describe('walkthrough', () => {
  it('builds chapters in group array order with first-appearance paths', () => {
    const chapters = buildChapters(insights, items);
    expect(chapters.map((chapter) => chapter.group.id)).toEqual(['entry', 'core']);
    expect(chapters[0].paths).toEqual(['src/hooks/useAuth.ts']);
    expect(chapters[0].items.map((item) => item.id)).toEqual(['a1', 'a2']);
  });

  it('walkthroughEnabled requires a summary', () => {
    expect(walkthroughEnabled(insights)).toBe(true);
    expect(walkthroughEnabled({ ...insights, summary: undefined })).toBe(false);
  });

  it('reveals only the first chapter with no cursor', () => {
    const chapters = buildChapters(insights, items);
    expect(revealedChapterCount(chapters, undefined)).toBe(1);
    expect(revealedChapterCount(chapters, 'b1')).toBe(2);
  });

  it('reveals the first chapter defensively for an unknown cursor', () => {
    const chapters = buildChapters(insights, items);
    expect(revealedChapterCount(chapters, 'does-not-exist')).toBe(1);
  });

  it('nextPosition walks the story order and ends', () => {
    const chapters = buildChapters(insights, items);
    expect(nextPosition(chapters, 'a2')).toEqual({ reviewItemId: 'b1', groupId: 'core' });
    expect(nextPosition(chapters, 'b1')).toBeUndefined();
  });

  it('storyIndexOf and chapterOf locate items, or report unknown', () => {
    const chapters = buildChapters(insights, items);
    expect(storyIndexOf(chapters, 'a1')).toBe(0);
    expect(storyIndexOf(chapters, 'b1')).toBe(2);
    expect(storyIndexOf(chapters, 'nope')).toBe(-1);
    expect(chapterOf(chapters, 'b1')?.group.id).toBe('core');
    expect(chapterOf(chapters, 'nope')).toBeUndefined();
  });

  it('skips item ids missing from the item map', () => {
    const insightsWithMissingId = {
      ...insights,
      groups: [{ id: 'entry', label: 'Entry', reviewItemIds: ['a1', 'ghost', 'a2'] }],
    } as ReviewInsights;
    const chapters = buildChapters(insightsWithMissingId, items);
    expect(chapters[0].items.map((item) => item.id)).toEqual(['a1', 'a2']);
  });
});
