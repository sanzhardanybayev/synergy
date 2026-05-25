/**
 * DiffOverlay — diff summary panel with hunk view and Mark-as-reviewed.
 *
 * Simplification note (v2): full pixel-perfect overlay-on-live-DOM is NOT
 * implemented. Instead we render a floating panel that shows the diff hunks
 * (context / add / remove lines with colour coding) alongside the summary
 * and the Mark-as-reviewed button. This is the bar specified for v2.
 *
 * Committed hunks use darker add/remove colours; uncommitted hunks use a
 * lighter palette — matching the spec colours (dark green / light green for
 * adds, dark red / light red for removes).
 *
 * If the API reports "not a git repo", we render an unavailable message and
 * no controls.
 */

import { useCallback, useEffect, useState } from 'react';
import { useToast } from './ToastProvider.js';
import type { DiffResult, Hunk } from './api.js';
import { getDiff, postReview } from './api.js';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface DiffOverlayProps {
  /**
   * sessionsDir-relative paths of the MDX file(s) on the current page.
   * Usually one file, but multi-file pages are supported.
   */
  files: string[];
}

// ---------------------------------------------------------------------------
// Hunk renderer
// ---------------------------------------------------------------------------

interface HunkViewProps {
  hunk: Hunk;
  committed: boolean;
}

function HunkView({ hunk, committed }: HunkViewProps) {
  return (
    <div className="diff-overlay__hunk">
      <div className="diff-overlay__hunk-header">
        @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
        {!committed && <span className="diff-overlay__uncommitted-badge"> uncommitted</span>}
      </div>
      {hunk.lines.map((line, i) => (
        <div
          key={`${line.kind}-${i}-${line.text.slice(0, 20)}`}
          className={`diff-overlay__line diff-overlay__line--${line.kind}${committed ? '' : ' diff-overlay__line--uncommitted'}`}
        >
          <span className="diff-overlay__line-prefix" aria-hidden="true">
            {line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' '}
          </span>
          <span className="diff-overlay__line-text">{line.text}</span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Per-file diff section
// ---------------------------------------------------------------------------

interface FileDiffProps {
  file: string;
  diff: DiffResult;
}

function FileDiff({ file, diff }: FileDiffProps) {
  if (!diff.available) {
    return <div className="diff-overlay__unavailable">Diff unavailable: not a git repo</div>;
  }

  const totalHunks = diff.hunks.length + diff.uncommittedHunks.length;
  const addedLines = countLines(diff.hunks, 'add') + countLines(diff.uncommittedHunks, 'add');
  const removedLines =
    countLines(diff.hunks, 'remove') + countLines(diff.uncommittedHunks, 'remove');

  if (totalHunks === 0) {
    return (
      <div className="diff-overlay__no-changes">
        <span className="diff-overlay__file-name">{file}</span>
        <span className="diff-overlay__no-changes-text"> — no changes since last review</span>
      </div>
    );
  }

  return (
    <div className="diff-overlay__file-section">
      <div className="diff-overlay__file-summary">
        <span className="diff-overlay__file-name">{file}</span>
        <span className="diff-overlay__stats">
          <span className="diff-overlay__added">+{addedLines}</span>
          {' · '}
          <span className="diff-overlay__removed">-{removedLines}</span>
          {' · '}
          <span className="diff-overlay__hunks">
            {totalHunks} hunk{totalHunks !== 1 ? 's' : ''}
          </span>
        </span>
      </div>

      <div className="diff-overlay__hunks-list">
        {diff.hunks.map((hunk) => (
          <HunkView
            key={`committed-${hunk.oldStart}-${hunk.newStart}`}
            hunk={hunk}
            committed={true}
          />
        ))}
        {diff.uncommittedHunks.map((hunk) => (
          <HunkView
            key={`uncommitted-${hunk.oldStart}-${hunk.newStart}`}
            hunk={hunk}
            committed={false}
          />
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function DiffOverlay({ files }: DiffOverlayProps) {
  const { show: showToast } = useToast();
  const [diffs, setDiffs] = useState<Map<string, DiffResult>>(new Map());
  const [loading, setLoading] = useState(false);
  const [reviewing, setReviewing] = useState(false);

  // -------------------------------------------------------------------------
  // Fetch diffs
  // -------------------------------------------------------------------------

  const fetchDiffs = useCallback(async () => {
    if (files.length === 0) return;
    setLoading(true);
    try {
      const results = await Promise.all(files.map((f) => getDiff(f)));
      const map = new Map<string, DiffResult>();
      files.forEach((f, i) => map.set(f, results[i]!));
      setDiffs(map);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to load diff');
    } finally {
      setLoading(false);
    }
  }, [files, showToast]);

  useEffect(() => {
    void fetchDiffs();
  }, [fetchDiffs]);

  // -------------------------------------------------------------------------
  // Mark as reviewed
  // -------------------------------------------------------------------------

  const handleMarkReviewed = useCallback(async () => {
    setReviewing(true);
    try {
      await Promise.all(files.map((f) => postReview(f)));
      await fetchDiffs();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to mark as reviewed');
    } finally {
      setReviewing(false);
    }
  }, [files, fetchDiffs, showToast]);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  const allUnavailable = diffs.size > 0 && [...diffs.values()].every((d) => !d.available);

  const hasChanges = [...diffs.values()].some(
    (d) => d.available && (d.hunks.length > 0 || d.uncommittedHunks.length > 0),
  );

  return (
    <section className="diff-overlay" aria-label="Diff view">
      <div className="diff-overlay__header">
        <h2 className="diff-overlay__title">Diff view</h2>
        {!allUnavailable && hasChanges && (
          <button
            type="button"
            className="diff-overlay__review-btn"
            disabled={reviewing || loading}
            onClick={() => void handleMarkReviewed()}
          >
            {reviewing ? 'Marking…' : 'Mark as reviewed'}
          </button>
        )}
      </div>

      {loading && <p className="diff-overlay__loading">Loading diff…</p>}

      {!loading && (
        <div className="diff-overlay__files">
          {files.map((f) => {
            const diff = diffs.get(f);
            if (!diff) return null;
            return <FileDiff key={f} file={f} diff={diff} />;
          })}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function countLines(hunks: Hunk[], kind: 'add' | 'remove'): number {
  return hunks.reduce((acc, h) => acc + h.lines.filter((l) => l.kind === kind).length, 0);
}
