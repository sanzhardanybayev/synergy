import type { ReviewItem, ReviewItemProgress } from '@synergy/review-core';

export interface HunkTabsProps {
  items: ReviewItem[];
  activeItemId: string;
  progress: Record<string, ReviewItemProgress>;
  onSelect(reviewItemId: string): void;
  /** When true, labels use the story order line-range form `H<n> · L<start>-<end>`. */
  storyMode?: boolean;
}

function isComplete(status: string | undefined): boolean {
  return status === 'reviewed' || status === 'carried-forward';
}

function tabLabel(item: ReviewItem, index: number, storyMode: boolean): string {
  if (storyMode) return `H${index + 1} · L${item.range.start}-${item.range.end}`;
  return item.kind === 'hunk' ? `Hunk ${index + 1}` : item.label;
}

/** Tab strip for the active file's review items. */
export function HunkTabs({
  items,
  activeItemId,
  progress,
  onSelect,
  storyMode = false,
}: HunkTabsProps) {
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
            {tabLabel(item, index, storyMode)}
          </button>
        );
      })}
    </div>
  );
}
