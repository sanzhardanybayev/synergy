import type {
  ReviewGroup,
  ReviewItem,
  ReviewItemProgress,
  ReviewItemStatus,
} from '@synergy/review-core';
import { useMemo, useState } from 'react';

interface ReviewSidebarProps {
  groups: ReviewGroup[];
  items: ReviewItem[];
  progress: Record<string, ReviewItemProgress>;
  activeItemId: string;
  onSelectItem(reviewItemId: string): void;
  onSetProgress(reviewItemId: string, status: 'reviewed' | 'needs-review'): Promise<void>;
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
}: ReviewSidebarProps) {
  const [query, setQuery] = useState('');
  const itemById = useMemo(() => new Map(items.map((item) => [item.id, item])), [items]);
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
          return (
            <section className="review-group" key={group.id}>
              <h2>{group.label}</h2>
              {paths.map((path) => {
                const fileItems = groupItems.filter((item) => item.path === path);
                const fileCompleted = fileItems.filter((item) =>
                  isComplete(progress[item.id]?.status),
                ).length;
                const fileComplete = fileCompleted === fileItems.length;
                const filePartial = fileCompleted > 0 && !fileComplete;
                return (
                  <div className="review-file" key={`${group.id}:${path}`}>
                    <label className="review-file__heading">
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
                      <span title={path}>{path}</span>
                    </label>
                    <ul>
                      {fileItems.map((item) => {
                        const itemComplete = isComplete(progress[item.id]?.status);
                        return (
                          <li key={item.id} className={item.id === activeItemId ? 'is-active' : ''}>
                            <input
                              type="checkbox"
                              checked={itemComplete}
                              aria-label={`${itemComplete ? 'Reopen' : 'Mark'} ${item.label} ${
                                itemComplete ? 'for review' : 'reviewed'
                              }`}
                              onChange={() =>
                                void onSetProgress(
                                  item.id,
                                  itemComplete ? 'needs-review' : 'reviewed',
                                )
                              }
                            />
                            <button
                              type="button"
                              aria-current={item.id === activeItemId ? 'true' : undefined}
                              onClick={() => onSelectItem(item.id)}
                            >
                              <span>{item.label}</span>
                              <small>
                                {item.kind === 'file'
                                  ? 'File-level change'
                                  : item.kind === 'hunk'
                                    ? `Lines ${item.range.start}–${item.range.end}`
                                    : `Section ${item.range.start}–${item.range.end}`}
                              </small>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
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
