import type { ReviewBundle, ReviewReadiness } from '@synergy/review-core';
import { ThemeToggle } from '../ThemeToggle.js';

interface ReviewHeaderProps {
  bundle: ReviewBundle;
  readiness: ReviewReadiness;
  captureFailed: boolean;
  walkthrough?: {
    enabled: boolean;
    setRevealAll(): void;
  };
}

function sourceLabel(bundle: ReviewBundle): string {
  const { source } = bundle.snapshot;
  if (source.kind === 'pr') return `PR #${source.number}`;
  if (source.kind === 'staged') return 'Staged changes';
  if (source.kind === 'unstaged') return 'Unstaged changes';
  return 'Codebase scope';
}

/** Keeps source identity, freshness, and durable review coverage visible. */
export function ReviewHeader({ bundle, readiness, captureFailed, walkthrough }: ReviewHeaderProps) {
  const completed = bundle.snapshot.items.length - readiness.pending - readiness.stale;
  const total = bundle.snapshot.items.length;
  const source = sourceLabel(bundle);
  // `insights.analysisPolicy` is stamped once at finalize time, so it stays true to what THIS
  // revision was actually analyzed under even if a later `review create` moves the workspace's
  // current policy. It is absent for an unfinalized revision (nothing stamped yet) or one
  // finalized before this field existed - both fall back to the workspace's live policy.
  const explainRemovals = Boolean(
    (bundle.insights.analysisPolicy ?? bundle.workspace.analysisPolicy)?.explainRemovals,
  );
  return (
    <header className={`review-header${walkthrough?.enabled ? ' review-header--walkthrough' : ''}`}>
      <div className="review-header__identity">
        <p className="review-eyebrow">{bundle.workspace.repository.name}</p>
        <h1>
          {bundle.snapshot.source.kind === 'pr' ? (
            <a
              className="review-source-link"
              href={bundle.snapshot.source.url}
              target="_blank"
              rel="noreferrer"
              title="Open the pull request in a new tab"
            >
              {source}
              <span aria-hidden="true"> ↗</span>
            </a>
          ) : (
            source
          )}{' '}
          review
        </h1>
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
        {bundle.snapshot.source.excludes && bundle.snapshot.source.excludes.length > 0 ? (
          <div className="review-header__fact--excludes">
            <dt>Excluded</dt>
            <dd title={bundle.snapshot.source.excludes.join(', ')}>
              {bundle.snapshot.source.excludes.join(', ')}
            </dd>
          </div>
        ) : null}
        <div className="review-header__fact--removal-policy">
          <dt>Removals</dt>
          <dd
            className={explainRemovals ? 'review-tone--success' : undefined}
            title="Whether every removal run captured by this review must carry a rationale before analysis can finalize."
          >
            {explainRemovals ? 'Required' : 'Optional'}
          </dd>
        </div>
      </dl>
      {walkthrough?.enabled ? (
        <div className="review-header__reveal">
          <button
            type="button"
            className="review-reveal-all"
            onClick={() => walkthrough.setRevealAll()}
          >
            Reveal all
          </button>
        </div>
      ) : null}
      <div className="review-header__theme" aria-label="Theme">
        <ThemeToggle />
      </div>
    </header>
  );
}
