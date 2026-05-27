/**
 * CommentHighlights — inline highlights and bubbles for open comments on the
 * current file. Matches the v2 design: anchor re-rendering + scroll on panel click.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useEditBuffer } from './EditBuffer.js';
import type { Comment } from './api.js';
import { listFeedback } from './api.js';
import { getMarkerPosition, getRangeClientRects, locateCommentInDom } from './commentDom.js';

export interface CommentHighlightsProps {
  session: string;
  /** Session-relative path, e.g. "00-overview.mdx". */
  file: string;
  fileSource: string;
}

interface CommentLayout {
  comment: Comment;
  kind: 'exact' | 'context' | 'stale';
  highlightRects: DOMRect[];
  marker: { top: number; left: number } | null;
}

const PULSE_MS = 2000;

export function CommentHighlights({ session, file, fileSource }: CommentHighlightsProps) {
  const { commentRefreshKey, focusedCommentId, clearFocusedComment } = useEditBuffer();
  const [comments, setComments] = useState<Comment[]>([]);
  const [layouts, setLayouts] = useState<CommentLayout[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [pulsingId, setPulsingId] = useState<string | null>(null);

  const fetchComments = useCallback(async () => {
    try {
      const { comments: all } = await listFeedback(session);
      setComments(all.filter((c) => c.status === 'open' && c.file === file));
    } catch {
      setComments([]);
    }
  }, [session, file]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: commentRefreshKey is an intentional re-fetch trigger, not used inside the effect body.
  useEffect(() => {
    void fetchComments();
  }, [fetchComments, commentRefreshKey]);

  const measureLayouts = useCallback(() => {
    const mdxBody = document.querySelector('.mdx-body');
    if (!mdxBody || !fileSource) {
      setLayouts([]);
      return;
    }

    const next: CommentLayout[] = [];
    for (const comment of comments) {
      const located = locateCommentInDom(mdxBody, fileSource, comment);
      if (located.kind === 'stale' || !located.range) {
        next.push({ comment, kind: 'stale', highlightRects: [], marker: null });
        continue;
      }
      const highlightRects = getRangeClientRects(located.range);
      const marker = getMarkerPosition(highlightRects);
      next.push({
        comment,
        kind: located.kind,
        highlightRects,
        marker,
      });
    }
    setLayouts(next);
  }, [comments, fileSource]);

  useEffect(() => {
    measureLayouts();
    const onLayout = () => measureLayouts();
    window.addEventListener('scroll', onLayout, true);
    window.addEventListener('resize', onLayout);
    const mdxBody = document.querySelector('.mdx-body');
    const ro = mdxBody ? new ResizeObserver(onLayout) : null;
    if (mdxBody && ro) ro.observe(mdxBody);
    return () => {
      window.removeEventListener('scroll', onLayout, true);
      window.removeEventListener('resize', onLayout);
      ro?.disconnect();
    };
  }, [measureLayouts]);

  // Scroll + pulse when a comment is focused from the panel.
  useEffect(() => {
    if (!focusedCommentId) return;

    const layout = layouts.find((l) => l.comment.id === focusedCommentId);
    if (!layout || layout.highlightRects.length === 0) {
      // Page or MDX may still be loading after navigation — wait for measureLayouts.
      return;
    }

    setExpandedId(focusedCommentId);
    setPulsingId(focusedCommentId);

    const first = layout.highlightRects[0]!;
    const elAtPoint = document.elementFromPoint(
      first.left + first.width / 2,
      first.top + first.height / 2,
    );
    const scrollTarget =
      elAtPoint?.closest('[data-source-line-start]') ?? document.querySelector('.mdx-body');
    scrollTarget?.scrollIntoView({ behavior: 'smooth', block: 'center' });

    const pulseTimer = window.setTimeout(() => setPulsingId(null), PULSE_MS);
    const clearTimer = window.setTimeout(() => clearFocusedComment(), PULSE_MS);
    return () => {
      window.clearTimeout(pulseTimer);
      window.clearTimeout(clearTimer);
    };
  }, [focusedCommentId, layouts, clearFocusedComment]);

  const visibleLayouts = useMemo(
    () => layouts.filter((l) => l.kind !== 'stale' && l.highlightRects.length > 0),
    [layouts],
  );

  if (visibleLayouts.length === 0) return null;

  return createPortal(
    <div className="comment-highlights" aria-label="Comment highlights">
      {visibleLayouts.map((layout) => (
        <CommentHighlightItem
          key={layout.comment.id}
          layout={layout}
          expanded={expandedId === layout.comment.id}
          pulsing={pulsingId === layout.comment.id}
          onToggle={() =>
            setExpandedId((id) => (id === layout.comment.id ? null : layout.comment.id))
          }
          onClose={() => setExpandedId(null)}
        />
      ))}
    </div>,
    document.body,
  );
}

interface ItemProps {
  layout: CommentLayout;
  expanded: boolean;
  pulsing: boolean;
  onToggle: () => void;
  onClose: () => void;
}

function CommentHighlightItem({ layout, expanded, pulsing, onToggle, onClose }: ItemProps) {
  const { comment, highlightRects, marker } = layout;
  if (!marker) return null;

  const bubbleTop = clamp(marker.top, 8, window.innerHeight - 48);
  const bubbleLeft = clamp(marker.left, 8, window.innerWidth - 320);

  return (
    <>
      {highlightRects.map((rect, i) => (
        <div
          key={`${comment.id}-hl-${i}`}
          className={`comment-highlight__range${pulsing ? ' comment-highlight__range--pulse' : ''}`}
          style={{
            position: 'fixed',
            top: rect.top,
            left: rect.left,
            width: rect.width,
            height: rect.height,
          }}
          aria-hidden
        />
      ))}

      <div
        className={`comment-highlight__bubble${expanded ? ' comment-highlight__bubble--expanded' : ''}`}
        style={{ position: 'fixed', top: bubbleTop, left: bubbleLeft }}
      >
        <button
          type="button"
          className="comment-highlight__bubble-btn"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-label={expanded ? 'Collapse comment' : `Comment: ${comment.body}`}
        >
          <span className="comment-highlight__bubble-icon" aria-hidden>
            💬
          </span>
          {!expanded && (
            <span className="comment-highlight__bubble-preview">{truncate(comment.body, 48)}</span>
          )}
        </button>

        {expanded && (
          // biome-ignore lint/a11y/useSemanticElements: role="region" on a div is intentional; no native element fits this inline popover.
          <div className="comment-highlight__popover" role="region" aria-label="Comment details">
            <p className="comment-highlight__body">{comment.body}</p>
            <button type="button" className="comment-highlight__close" onClick={onClose}>
              Close
            </button>
          </div>
        )}
      </div>
    </>
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}
