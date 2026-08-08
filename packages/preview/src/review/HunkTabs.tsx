import type { ReviewItem, ReviewItemProgress } from '@synergy/review-core';

export interface HunkTabsProps {
  items: ReviewItem[];
  activeItemId: string;
  progress: Record<string, ReviewItemProgress>;
  onSelect(reviewItemId: string): void;
}

function isComplete(status: string | undefined): boolean {
  return status === 'reviewed' || status === 'carried-forward';
}

/** Tab strip for the active file's review items. */
export function HunkTabs({ items, activeItemId, progress, onSelect }: HunkTabsProps) {
  return (
    <div className="review-hunk-tabs" role="tablist" aria-label="Review items in this file">
      {items.map((item, index) => {
        const reviewed = isComplete(progress[item.id]?.status);
        const active = item.id === activeItemId;
        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={active}
            data-reviewed={reviewed ? 'true' : 'false'}
            className={`review-hunk-tab${active ? ' is-active' : ''}`}
            onClick={() => onSelect(item.id)}
          >
            <span className="review-hunk-tab__check" aria-hidden="true">
              {reviewed ? '✓' : ''}
            </span>
            {item.kind === 'hunk' ? `Hunk ${index + 1}` : item.label}
          </button>
        );
      })}
    </div>
  );
}
