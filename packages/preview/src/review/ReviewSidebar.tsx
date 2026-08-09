import type {
  ReviewGroup,
  ReviewItem,
  ReviewItemProgress,
  ReviewItemStatus,
} from '@synergy/review-core';
import { useMemo, useState } from 'react';
import type { Chapter } from './walkthrough.js';

interface SidebarWalkthrough {
  enabled: boolean;
  chapters: Chapter[];
  revealedCount: number;
  currentChapterIndex: number;
  advanceTo(reviewItemId: string): void;
}

interface ReviewSidebarProps {
  groups: ReviewGroup[];
  items: ReviewItem[];
  progress: Record<string, ReviewItemProgress>;
  activeItemId: string;
  onSelectItem(reviewItemId: string): void;
  onSetProgress(reviewItemId: string, status: 'reviewed' | 'needs-review'): Promise<void>;
  walkthrough?: SidebarWalkthrough;
}

function isComplete(status: ReviewItemStatus | undefined): boolean {
  return status === 'reviewed' || status === 'carried-forward';
}

/** Provides searchable group, file, and review-item coverage for the current revision. */
export function ReviewSidebar({
  groups,
  items,
  progress,
  activeItemId,
  onSelectItem,
  onSetProgress,
  walkthrough,
}: ReviewSidebarProps) {
  const [query, setQuery] = useState('');
  const itemById = useMemo(() => new Map(items.map((item) => [item.id, item])), [items]);
  const chapterByGroupId = useMemo(
    () => new Map((walkthrough?.chapters ?? []).map((chapter) => [chapter.group.id, chapter])),
    [walkthrough],
  );
  const normalizedQuery = query.trim().toLowerCase();
  const completed = items.filter((item) => isComplete(progress[item.id]?.status)).length;
  const hasMatches = groups.some((group) =>
    group.reviewItemIds.some((id) => {
      const item = itemById.get(id);
      return item && (!normalizedQuery || item.path.toLowerCase().includes(normalizedQuery));
    }),
  );

  return (
    <nav className="review-sidebar" aria-label="Review contents">
      <div className="review-sidebar__progress">
        <div>
          <span>Coverage</span>
          <strong>
            {completed}/{items.length}
          </strong>
        </div>
        <progress value={completed} max={Math.max(items.length, 1)}>
          {completed} of {items.length}
        </progress>
      </div>
      <label className="review-search">
        <span>Find a file</span>
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Filter paths"
        />
      </label>
      <div className="review-sidebar__groups">
        {groups.map((group) => {
          const groupItems = group.reviewItemIds
            .map((id) => itemById.get(id))
            .filter((item): item is ReviewItem => item !== undefined)
            .filter(
              (item) => !normalizedQuery || item.path.toLowerCase().includes(normalizedQuery),
            );
          const paths = [...new Set(groupItems.map((item) => item.path))];
          if (paths.length === 0) return null;
          const chapter = walkthrough?.enabled ? chapterByGroupId.get(group.id) : undefined;
          const locked =
            chapter !== undefined && chapter.index >= (walkthrough?.revealedCount ?? 0);
          const isCurrent =
            chapter !== undefined && chapter.index === walkthrough?.currentChapterIndex;
          const isDone =
            chapter !== undefined && chapter.index < (walkthrough?.currentChapterIndex ?? 0);
          const sectionClassName = `review-group${locked ? ' review-chapter--locked' : ''}`;
          return (
            <section className={sectionClassName} key={group.id}>
              {chapter ? (
                <button
                  type="button"
                  className="review-chapter-head"
                  onClick={() => {
                    const firstItem = chapter.items[0];
                    if (firstItem) walkthrough?.advanceTo(firstItem.id);
                  }}
                >
                  <span
                    className={`review-chapter-num${isCurrent ? ' is-current' : ''}${
                      isDone ? ' is-done' : ''
                    }${locked ? ' is-locked' : ''}`}
                    aria-hidden="true"
                  >
                    {isDone ? '✓' : chapter.index + 1}
                  </span>
                  <span className="review-chapter-title">{group.label}</span>
                  <span className="review-chapter-meta">
                    {locked ? '· · ·' : `${paths.length} file${paths.length === 1 ? '' : 's'}`}
                  </span>
                </button>
              ) : (
                <h2>{group.label}</h2>
              )}
              {paths.map((path) => {
                const fileItems = groupItems.filter((item) => item.path === path);
                const fileCompleted = fileItems.filter((item) =>
                  isComplete(progress[item.id]?.status),
                ).length;
                const fileComplete = fileCompleted === fileItems.length;
                const filePartial = fileCompleted > 0 && !fileComplete;
                const fileActive = fileItems.some((item) => item.id === activeItemId);
                const firstUnreviewed = fileItems.find(
                  (item) => !isComplete(progress[item.id]?.status),
                );
                const selectionTarget = firstUnreviewed ?? fileItems[0];
                return (
                  <div
                    className={`review-file${fileActive ? ' is-active' : ''}`}
                    key={`${group.id}:${path}`}
                  >
                    <input
                      type="checkbox"
                      ref={(input) => {
                        if (input) input.indeterminate = filePartial;
                      }}
                      checked={fileComplete}
                      aria-label={`${fileComplete ? 'Reopen' : 'Mark'} ${path} ${
                        fileComplete ? 'for review' : 'reviewed'
                      }`}
                      onChange={() => {
                        const next = fileComplete ? 'needs-review' : 'reviewed';
                        void Promise.all(fileItems.map((item) => onSetProgress(item.id, next)));
                      }}
                    />
                    <button
                      type="button"
                      className="review-file__heading"
                      aria-current={fileActive ? 'true' : undefined}
                      onClick={() => {
                        if (selectionTarget) onSelectItem(selectionTarget.id);
                      }}
                    >
                      <span title={path}>{path}</span>
                      <small>
                        {fileCompleted}/{fileItems.length}
                      </small>
                    </button>
                  </div>
                );
              })}
            </section>
          );
        })}
        {!hasMatches ? (
          <output className="review-sidebar__empty">No files match this filter.</output>
        ) : null}
      </div>
      <p className="review-sidebar__shortcuts">
        <kbd>J</kbd>/<kbd>K</kbd> move · <kbd>R</kbd> review · <kbd>?</kbd> ask
      </p>
    </nav>
  );
}
