/**
 * CommentsPanel — right-side collapsible panel for feedback comments.
 *
 * Fetches open (and optionally resolved/rejected) comments for the current
 * session. Each comment shows an anchor snippet, body, file path, age, and
 * Resolve/Reject buttons.
 *
 * Open-comment count is surfaced via onCountChange so the toolbar badge can
 * stay updated without this component knowing about the toolbar.
 *
 * Clicking a comment calls onScrollToAnchor — the integration agent wires
 * actual scroll behaviour.
 */

import { useCallback, useEffect, useState } from 'react';
import { useEditBuffer } from './EditBuffer.js';
import { useToast } from './ToastProvider.js';
import type { Comment } from './api.js';
import { listFeedback, patchFeedback, postReviewDone } from './api.js';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface CommentsPanelProps {
  /** The session slug, e.g. "2026-05-25-foo-feature". */
  session: string;
  /**
   * Increment to trigger a refetch (e.g. after CommentLayer posts a new
   * comment).
   */
  refreshKey?: number;
  /** Called when the user clicks a comment item to scroll to its anchor. */
  onScrollToAnchor?: (comment: Comment) => void;
  /** Called whenever the open-comment count changes. */
  onCountChange?: (n: number) => void;
}

// ---------------------------------------------------------------------------
// Comment card
// ---------------------------------------------------------------------------

interface CardProps {
  comment: Comment;
  onResolve: (id: string) => Promise<void>;
  onReject: (id: string) => Promise<void>;
  onClick: (comment: Comment) => void;
}

function CommentCard({ comment, onResolve, onReject, onClick }: CardProps) {
  const [rejecting, setRejecting] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [busy, setBusy] = useState(false);

  const handleResolve = useCallback(async () => {
    setBusy(true);
    try {
      await onResolve(comment.id);
    } finally {
      setBusy(false);
    }
  }, [comment.id, onResolve]);

  const handleRejectSubmit = useCallback(async () => {
    if (!rejectReason.trim()) return;
    setBusy(true);
    try {
      await onReject(`${comment.id}|${rejectReason.trim()}`);
    } finally {
      setBusy(false);
      setRejecting(false);
      setRejectReason('');
    }
  }, [comment.id, rejectReason, onReject]);

  const isOpen = comment.status === 'open';

  return (
    <article
      className={`comments-panel__card${isOpen ? '' : ' comments-panel__card--resolved'}`}
      onClick={() => onClick(comment)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') onClick(comment);
      }}
      aria-label={`Comment: ${comment.anchor.selected}`}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: article is intentionally interactive (click-to-scroll)
      tabIndex={0}
    >
      <div className="comments-panel__anchor">
        {comment.anchor.before.length > 0 && (
          <span className="comments-panel__anchor-before">…{comment.anchor.before}</span>
        )}
        <strong className="comments-panel__anchor-selected">{comment.anchor.selected}</strong>
        {comment.anchor.after.length > 0 && (
          <span className="comments-panel__anchor-after">{comment.anchor.after}…</span>
        )}
      </div>

      <p className="comments-panel__body">{comment.body}</p>

      <div className="comments-panel__meta">
        <span className="comments-panel__file">{comment.file}</span>
        <span className="comments-panel__age">{formatAge(comment.created)}</span>
      </div>

      {isOpen && (
        <div className="comments-panel__actions">
          {!rejecting ? (
            <>
              <button
                type="button"
                className="comments-panel__resolve-btn"
                disabled={busy}
                onClick={(e) => {
                  e.stopPropagation();
                  void handleResolve();
                }}
                aria-label="Resolve comment"
              >
                ✓ Resolve
              </button>
              <button
                type="button"
                className="comments-panel__reject-btn"
                disabled={busy}
                onClick={(e) => {
                  e.stopPropagation();
                  setRejecting(true);
                }}
                aria-label="Reject comment"
              >
                ✕ Reject
              </button>
            </>
          ) : (
            <div
              className="comments-panel__reject-form"
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => e.stopPropagation()}
            >
              <input
                className="comments-panel__reject-input"
                type="text"
                placeholder="Reason for rejection…"
                value={rejectReason}
                onChange={(e) => setRejectReason(e.target.value)}
                // biome-ignore lint/a11y/noAutofocus: reject reason input is modal-like; autofocus is expected UX here
                autoFocus
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === 'Enter') void handleRejectSubmit();
                  if (e.key === 'Escape') {
                    setRejecting(false);
                    setRejectReason('');
                  }
                }}
              />
              <button
                type="button"
                className="comments-panel__reject-submit"
                disabled={busy || !rejectReason.trim()}
                onClick={() => void handleRejectSubmit()}
              >
                Submit
              </button>
              <button
                type="button"
                className="comments-panel__reject-cancel"
                disabled={busy}
                onClick={() => {
                  setRejecting(false);
                  setRejectReason('');
                }}
              >
                Cancel
              </button>
            </div>
          )}
        </div>
      )}

      {comment.status === 'resolved' && comment.resolution && (
        <p className="comments-panel__resolution">
          <strong>Resolved:</strong> {comment.resolution}
        </p>
      )}

      {comment.status === 'rejected' && comment.rejection_reason && (
        <p className="comments-panel__rejection">
          <strong>Rejected:</strong> {comment.rejection_reason}
        </p>
      )}
    </article>
  );
}

// ---------------------------------------------------------------------------
// Main panel
// ---------------------------------------------------------------------------

export function CommentsPanel({
  session,
  refreshKey,
  onScrollToAnchor,
  onCountChange,
}: CommentsPanelProps) {
  const { show: showToast } = useToast();
  const { agentListening } = useEditBuffer();
  const [comments, setComments] = useState<Comment[]>([]);
  const [loading, setLoading] = useState(false);
  const [showResolved, setShowResolved] = useState(false);
  const [endingReview, setEndingReview] = useState(false);

  const handleReviewDone = useCallback(async () => {
    setEndingReview(true);
    try {
      await postReviewDone(session);
      showToast(
        agentListening
          ? 'Review ended — a waiting agent picks up your remaining comments now.'
          : 'Review ended — no agent is listening right now, so comments will be picked up on the next /synergy-feedback.',
      );
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to end the review');
    } finally {
      setEndingReview(false);
    }
  }, [session, showToast, agentListening]);

  // -------------------------------------------------------------------------
  // Fetch
  // -------------------------------------------------------------------------

  const fetchComments = useCallback(async () => {
    setLoading(true);
    try {
      const { comments: fetched } = await listFeedback(session);
      setComments(fetched);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to load comments');
    } finally {
      setLoading(false);
    }
  }, [session, showToast]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey is a prop that triggers an intentional refetch when incremented
  useEffect(() => {
    void fetchComments();
  }, [fetchComments, refreshKey]);

  // Notify parent of open-comment count changes.
  useEffect(() => {
    const openCount = comments.filter((c) => c.status === 'open').length;
    onCountChange?.(openCount);
  }, [comments, onCountChange]);

  // -------------------------------------------------------------------------
  // Resolve / Reject handlers
  // -------------------------------------------------------------------------

  const handleResolve = useCallback(
    async (id: string) => {
      try {
        await patchFeedback(id, { status: 'resolved', resolution: '' });
        await fetchComments();
      } catch (err) {
        showToast(err instanceof Error ? err.message : 'Failed to resolve comment');
      }
    },
    [fetchComments, showToast],
  );

  const handleReject = useCallback(
    async (idAndReason: string) => {
      // Encoded as "id|reason" by the card to avoid an extra closure param.
      const pipeIdx = idAndReason.indexOf('|');
      const id = idAndReason.slice(0, pipeIdx);
      const rejection_reason = idAndReason.slice(pipeIdx + 1);
      try {
        await patchFeedback(id, { status: 'rejected', rejection_reason });
        await fetchComments();
      } catch (err) {
        showToast(err instanceof Error ? err.message : 'Failed to reject comment');
      }
    },
    [fetchComments, showToast],
  );

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  const openComments = comments.filter((c) => c.status === 'open');
  const closedComments = comments.filter((c) => c.status !== 'open');
  const visibleComments = showResolved ? [...openComments, ...closedComments] : openComments;

  return (
    <div className="comments-panel">
      <div className="comments-panel__header">
        <h2 className="comments-panel__title">
          Comments
          {openComments.length > 0 && (
            <span className="comments-panel__badge">{openComments.length}</span>
          )}
        </h2>
        <span
          className={`comments-panel__presence${agentListening ? ' comments-panel__presence--live' : ''}`}
          title={
            agentListening
              ? 'An agent is waiting for your comments — it picks them up the moment you post'
              : 'No agent is listening right now — comments are saved and picked up on the next /synergy-feedback'
          }
        >
          <span className="comments-panel__presence-dot" aria-hidden="true" />
          {agentListening ? 'Agent listening' : 'No agent'}
        </span>
        {closedComments.length > 0 && (
          <button
            type="button"
            className="comments-panel__toggle"
            onClick={() => setShowResolved((v) => !v)}
          >
            {showResolved ? 'Hide resolved' : `Show resolved (${closedComments.length})`}
          </button>
        )}
        <button
          type="button"
          className="comments-panel__done-btn"
          disabled={endingReview}
          onClick={() => void handleReviewDone()}
          title="End this review round — a waiting agent handles your remaining comments; otherwise they're picked up on the next /synergy-feedback"
        >
          Done reviewing
        </button>
      </div>

      {loading && <p className="comments-panel__loading">Loading comments…</p>}

      {!loading && visibleComments.length === 0 && (
        <p className="comments-panel__empty">No open comments.</p>
      )}

      <div className="comments-panel__list">
        {visibleComments.map((comment) => (
          <CommentCard
            key={comment.id}
            comment={comment}
            onResolve={handleResolve}
            onReject={handleReject}
            onClick={(c) => onScrollToAnchor?.(c)}
          />
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatAge(created: string): string {
  const now = Date.now();
  const then = new Date(created).getTime();
  if (Number.isNaN(then)) return created;

  const diffMs = now - then;
  const diffSec = Math.floor(diffMs / 1000);

  if (diffSec < 60) return 'just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}
