import type { ReviewGroup, ReviewInsights, ReviewItem } from '@synergy/review-core';

export interface Chapter {
  group: ReviewGroup;
  index: number;
  items: ReviewItem[];
  paths: string[];
}

export function walkthroughEnabled(insights: ReviewInsights): boolean {
  return insights.summary !== undefined;
}

export function buildChapters(insights: ReviewInsights, items: ReviewItem[]): Chapter[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  return insights.groups.map((group, index) => {
    const chapterItems: ReviewItem[] = [];
    const paths: string[] = [];
    const seenPaths = new Set<string>();
    for (const id of group.reviewItemIds) {
      const item = byId.get(id);
      if (!item) continue;
      chapterItems.push(item);
      if (!seenPaths.has(item.path)) {
        seenPaths.add(item.path);
        paths.push(item.path);
      }
    }
    return { group, index, items: chapterItems, paths };
  });
}

export function storyIndexOf(chapters: Chapter[], reviewItemId: string): number {
  let position = 0;
  for (const chapter of chapters) {
    for (const item of chapter.items) {
      if (item.id === reviewItemId) return position;
      position += 1;
    }
  }
  return -1;
}

export function chapterOf(chapters: Chapter[], reviewItemId: string): Chapter | undefined {
  return chapters.find((chapter) => chapter.items.some((item) => item.id === reviewItemId));
}

export function revealedChapterCount(
  chapters: Chapter[],
  cursorItemId: string | undefined,
): number {
  if (cursorItemId === undefined) return 1;
  const chapter = chapterOf(chapters, cursorItemId);
  if (!chapter) return 1;
  return chapter.index + 1;
}

export function nextPosition(
  chapters: Chapter[],
  currentItemId: string,
): { reviewItemId: string; groupId: string } | undefined {
  const flatItems: Array<{ item: ReviewItem; group: ReviewGroup }> = [];
  for (const chapter of chapters) {
    for (const item of chapter.items) {
      flatItems.push({ item, group: chapter.group });
    }
  }
  const currentIndex = flatItems.findIndex(({ item }) => item.id === currentItemId);
  if (currentIndex === -1) return undefined;
  const next = flatItems[currentIndex + 1];
  if (!next) return undefined;
  return { reviewItemId: next.item.id, groupId: next.group.id };
}
