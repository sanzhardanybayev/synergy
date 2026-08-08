import type { ReviewItem } from '@synergy/review-core';
import { useEffect, useMemo, useRef } from 'react';
import { QuestionRail } from './QuestionRail.js';
import { ReviewHeader } from './ReviewHeader.js';
import { useReview } from './ReviewProvider.js';
import { ReviewSidebar } from './ReviewSidebar.js';
import { ReviewStage } from './ReviewStage.js';

function orderedItems(items: ReviewItem[], groupItemIds: string[][]): ReviewItem[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const seen = new Set<string>();
  const ordered: ReviewItem[] = [];
  for (const id of [...groupItemIds.flat(), ...items.map((item) => item.id)]) {
    const item = byId.get(id);
    if (item && !seen.has(id)) {
      ordered.push(item);
      seen.add(id);
    }
  }
  return ordered;
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT'
  );
}

/** Coordinates the three-column human review workspace and its keyboard workflow. */
export function ReviewShell() {
  const review = useReview();
  const questionInputRef = useRef<HTMLTextAreaElement>(null);
  const items = useMemo(
    () =>
      review.bundle
        ? orderedItems(
            review.bundle.snapshot.items,
            review.bundle.insights.groups.map((group) => group.reviewItemIds),
          )
        : [],
    [review.bundle],
  );
  const activeItem = items.find((item) => item.id === review.activeItemId) ?? items[0] ?? null;
  // Filters by path across ALL groups, not just the active item's group, whereas ReviewSidebar
  // keys its per-file rows as `${group.id}:${path}`. This only matches the sidebar's grouping
  // when every review item for a given path lives in a single group. The analysis validator
  // (assertValidAnalysis in review-actions.ts) rejects a review item appearing in more than one
  // group, but it does not forbid two distinct items at the same path from landing in different
  // groups - that split just isn't something agent-authored analyses produce today. If it ever
  // does happen, this filter would silently merge items from another group into the file view.
  const fileItems = useMemo(
    () => (activeItem ? items.filter((item) => item.path === activeItem.path) : []),
    [items, activeItem],
  );
  const fileInsight = review.bundle?.insights.files?.find(
    (candidate) => candidate.path === activeItem?.path,
  );

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (isEditableTarget(event.target)) return;
      if (event.metaKey || event.ctrlKey || event.altKey || event.repeat) return;
      const key = event.key.toLowerCase();
      if (key === '?') {
        event.preventDefault();
        questionInputRef.current?.focus();
        return;
      }
      if (!activeItem || items.length === 0) return;
      const currentIndex = items.findIndex((item) => item.id === activeItem.id);
      if (key === 'j' || key === 'k') {
        event.preventDefault();
        const offset = key === 'j' ? 1 : -1;
        const nextIndex = Math.min(Math.max(currentIndex + offset, 0), items.length - 1);
        review.setActiveItem(items[nextIndex]!.id);
      }
      if (key === 'r') {
        event.preventDefault();
        const status = review.bundle?.progress.items[activeItem.id]?.status;
        const complete = status === 'reviewed' || status === 'carried-forward';
        void review.markProgress(activeItem.id, complete ? 'needs-review' : 'reviewed');
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeItem, items, review]);

  if (review.status === 'loading') {
    return (
      <main className="review-route-state" aria-busy="true">
        <span className="review-route-state__pulse" aria-hidden="true" />
        <h1>Preparing your review…</h1>
        <p>Loading the exact source snapshot and your saved progress.</p>
      </main>
    );
  }

  if (review.status === 'error' || !review.bundle || !review.readiness) {
    const error = review.error ?? 'review_unavailable';
    const isUnknown = error.includes('review_not_found');
    const isCorrupt = error.includes('review_corrupt') || error.includes('invalid review response');
    return (
      <main className="review-route-state">
        <p className="review-eyebrow">Synergy review</p>
        <h1>
          {isUnknown
            ? 'Review not found'
            : isCorrupt
              ? 'Review data is invalid'
              : 'Review unavailable'}
        </h1>
        <p>
          {isUnknown
            ? 'This review reference does not exist in the current repository.'
            : isCorrupt
              ? 'The saved review could not be validated, so Synergy left it unchanged.'
              : 'The local review service could not load this revision.'}
        </p>
        <button
          className="review-button review-button--primary"
          type="button"
          onClick={() => void review.retry()}
        >
          Try again
        </button>
      </main>
    );
  }

  if (!activeItem) {
    if (!review.analysisFinalized) {
      return (
        <main className="review-route-state" aria-busy="true">
          <span className="review-route-state__pulse" aria-hidden="true" />
          <h1>Preparing review analysis…</h1>
          <p>Synergy is identifying the exact code sections that need your review.</p>
        </main>
      );
    }
    return (
      <main className="review-route-state">
        <h1>No reviewable items</h1>
        <p>This revision contains no analyzed text items.</p>
      </main>
    );
  }

  return (
    <div className="review-shell">
      <ReviewHeader
        bundle={review.bundle}
        readiness={review.readiness}
        captureFailed={review.captureFailed}
      />
      {review.error ? (
        <div className="review-global-alert" role="alert">
          {review.error}
        </div>
      ) : null}
      <div className="review-shell__columns">
        <ReviewSidebar
          groups={review.bundle.insights.groups}
          items={items}
          progress={review.bundle.progress.items}
          activeItemId={activeItem.id}
          onSelectItem={review.setActiveItem}
          onSetProgress={review.markProgress}
        />
        <ReviewStage
          bundle={review.bundle}
          item={activeItem}
          fileItems={fileItems}
          fileInsight={fileInsight}
          selectedLineIds={review.selectedLineIds}
          noteDraft={review.noteDrafts[activeItem.id]}
          saving={review.savingItemIds.has(activeItem.id)}
          onToggleLine={review.toggleSelectedLine}
          onNoteChange={(value) => review.setNoteDraft(activeItem.id, value)}
          onSaveNote={() => review.saveNote(activeItem.id)}
          onSetProgress={(status) => review.markProgress(activeItem.id, status)}
          onSelectItem={review.setActiveItem}
        />
        <QuestionRail questionInputRef={questionInputRef} />
      </div>
    </div>
  );
}
