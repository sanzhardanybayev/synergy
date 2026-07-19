import type { ReviewBundle, ReviewReadiness } from '@synergy/review-core';
import { ThemeToggle } from '../ThemeToggle.js';

interface ReviewHeaderProps {
  bundle: ReviewBundle;
  readiness: ReviewReadiness;
  captureFailed: boolean;
}

function sourceLabel(bundle: ReviewBundle): string {
  const { source } = bundle.snapshot;
  if (source.kind === 'pr') return `PR #${source.number}`;
  if (source.kind === 'staged') return 'Staged changes';
  if (source.kind === 'unstaged') return 'Unstaged changes';
  return 'Codebase scope';
}

/** Keeps source identity, freshness, and durable review coverage visible. */
export function ReviewHeader({ bundle, readiness, captureFailed }: ReviewHeaderProps) {
  const completed = bundle.snapshot.items.length - readiness.pending - readiness.stale;
  const total = bundle.snapshot.items.length;
  const source = sourceLabel(bundle);
  return (
    <header className="review-header">
      <div className="review-header__identity">
        <p className="review-eyebrow">{bundle.workspace.repository.name}</p>
        <h1>{source} review</h1>
      </div>
      <dl className="review-header__facts">
        <div className="review-header__fact--revision">
          <dt>Revision</dt>
          <dd title={bundle.snapshot.revisionId}>{bundle.snapshot.revisionId}</dd>
        </div>
        <div className="review-header__fact--source">
          <dt>Source</dt>
          <dd>{source}</dd>
        </div>
        <div className="review-header__fact--freshness">
          <dt>Freshness</dt>
          <dd
            className={
              captureFailed
                ? 'review-tone--danger'
                : bundle.sourceChanged
                  ? 'review-tone--warning'
                  : 'review-tone--success'
            }
          >
            {captureFailed ? 'Unverified' : bundle.sourceChanged ? 'Changed' : 'Current'}
          </dd>
        </div>
        <div className="review-header__fact--progress">
          <dt>Progress</dt>
          <dd>
            {completed} of {total}
          </dd>
        </div>
      </dl>
      <div className="review-header__theme" aria-label="Theme">
        <ThemeToggle />
      </div>
    </header>
  );
}
