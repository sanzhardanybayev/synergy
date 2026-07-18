/**
 * CommentLayer — selection → "+" button → composer → POST flow.
 *
 * Renders a floating "+" button when the user has a non-empty text selection
 * inside .mdx-body, then a composer popover when clicked. On Send, computes
 * an anchor and POSTs via api.postFeedback.
 *
 * Anchor approximation (v2 accepted limitation):
 *  We map selection offsets within the block's textContent directly to source
 *  offsets. For single-line blocks this is exact. For soft-wrapped multi-line
 *  paragraphs it is approximate. The before+selected+after context string
 *  is the drift-tolerant fallback. See commentAnchors.ts for full notes.
 *
 * This component does NOT touch any shell files (main.tsx, App.tsx, etc.).
 * The integration agent mounts it and passes session/file props.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useToast } from './ToastProvider.js';
import type { CommentAnchor } from './api.js';
import { postFeedback } from './api.js';
import { computeAnchor } from './commentAnchors.js';
import { PlusIcon } from './icons.js';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface CommentLayerProps {
  /** The session slug, e.g. "2026-05-25-foo-feature". */
  session: string;
  /**
   * Session-relative file path, e.g. "00-overview.mdx" or
   * "phases/01-core/spec.mdx".
   */
  file: string;
  /**
   * Full source text of the current file. Needed to convert DOM selection
   * offsets to line/col coordinates.
   */
  fileSource: string;
  /** Called after a comment is successfully POSTed. */
  onPosted?: () => void;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface SelectionState {
  anchor: CommentAnchor;
  /** Viewport coordinates from getBoundingClientRect (for position: fixed). */
  rectTop: number;
  rectBottom: number;
  rectLeft: number;
  rectRight: number;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function CommentLayer({ session, file, fileSource, onPosted }: CommentLayerProps) {
  const { show: showToast } = useToast();

  const [selection, setSelection] = useState<SelectionState | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);

  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // -------------------------------------------------------------------------
  // Handle selection change
  // -------------------------------------------------------------------------

  const handleSelectionChange = useCallback(() => {
    // While the composer is open, focusing the textarea collapses the document
    // selection. Ignore those changes so the composer (and its anchored
    // selection) survives the focus shift.
    if (composerOpen) return;

    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
      setSelection(null);
      return;
    }

    const selectedText = sel.toString();
    if (!selectedText.trim()) {
      setSelection(null);
      return;
    }

    const range = sel.getRangeAt(0);

    // Only respond to selections inside .mdx-body.
    const mdxBody = document.querySelector('.mdx-body');
    if (!mdxBody || !mdxBody.contains(range.commonAncestorContainer)) {
      setSelection(null);
      return;
    }

    // Find the closest ancestor element with data-source-line-start.
    const blockEl = findBlockElement(range.commonAncestorContainer);
    if (!blockEl) {
      setSelection(null);
      return;
    }

    const blockAttrs = readBlockAttrs(blockEl);
    if (!blockAttrs) {
      setSelection(null);
      return;
    }

    // Compute selection offsets within the block's textContent.
    const blockText = blockEl.textContent ?? '';
    const { start: selStart, end: selEnd } = getSelectionOffsetsInElement(blockEl, range);

    // Guard: offsets must be within block text bounds.
    if (selStart < 0 || selEnd > blockText.length || selStart >= selEnd) {
      setSelection(null);
      return;
    }

    let anchor: CommentAnchor;
    try {
      anchor = computeAnchor(fileSource, blockAttrs, selStart, selEnd, selectedText, blockText);
    } catch (err) {
      // fileSource unavailable or offsets out of bounds is expected; log anything
      // else so a genuine anchor-computation bug isn't silently invisible (the
      // "+" button just wouldn't appear, with no explanation).
      if (!(err instanceof RangeError)) {
        console.warn('[synergy] computeAnchor failed unexpectedly:', err);
      }
      setSelection(null);
      return;
    }

    // getBoundingClientRect is not available in jsdom — guard defensively.
    const rect =
      typeof range.getBoundingClientRect === 'function'
        ? range.getBoundingClientRect()
        : new DOMRect(0, 0, 0, 0);
    setSelection({
      anchor,
      rectTop: rect.top,
      rectBottom: rect.bottom,
      rectLeft: rect.left,
      rectRight: rect.right,
    });
  }, [fileSource, composerOpen]);

  useEffect(() => {
    document.addEventListener('selectionchange', handleSelectionChange);
    return () => document.removeEventListener('selectionchange', handleSelectionChange);
  }, [handleSelectionChange]);

  // -------------------------------------------------------------------------
  // Composer open/close
  // -------------------------------------------------------------------------

  const openComposer = useCallback(() => {
    setComposerOpen(true);
    setBody('');
    // Focus textarea on next tick (after render).
    setTimeout(() => textareaRef.current?.focus(), 0);
  }, []);

  const closeComposer = useCallback(() => {
    setComposerOpen(false);
    setBody('');
    setSelection(null);
  }, []);

  // -------------------------------------------------------------------------
  // Keyboard: Esc closes composer
  // -------------------------------------------------------------------------

  useEffect(() => {
    if (!composerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeComposer();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [composerOpen, closeComposer]);

  // -------------------------------------------------------------------------
  // Send
  // -------------------------------------------------------------------------

  const handleSend = useCallback(async () => {
    if (!selection || !body.trim() || sending) return;

    setSending(true);
    try {
      await postFeedback({ session, file, anchor: selection.anchor, body: body.trim() });
      closeComposer();
      // Clear the DOM selection so the "+" button disappears.
      window.getSelection()?.removeAllRanges();
      onPosted?.();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to post comment');
    } finally {
      setSending(false);
    }
  }, [selection, body, sending, session, file, closeComposer, onPosted, showToast]);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  if (!selection) return null;

  const addBtnPos = floatingAddButtonPosition(selection);
  const composerPos = floatingComposerPosition(selection);

  return createPortal(
    <div className="comment-layer">
      {!composerOpen && (
        <button
          type="button"
          className="comment-layer__add-btn"
          style={{ top: addBtnPos.top, left: addBtnPos.left }}
          aria-label="Add comment"
          onMouseDown={(e) => {
            // Prevent the click from clearing the selection.
            e.preventDefault();
          }}
          onClick={openComposer}
        >
          <PlusIcon size={14} />
        </button>
      )}

      {composerOpen && (
        // biome-ignore lint/a11y/useSemanticElements: <dialog> element would reset browser positioning; floating composer needs position:fixed
        <div
          role="dialog"
          className="comment-layer__composer"
          style={{ top: composerPos.top, left: composerPos.left }}
          aria-label="Add comment"
        >
          <textarea
            ref={textareaRef}
            className="comment-layer__composer-textarea"
            placeholder="Leave a note for Claude…"
            value={body}
            rows={4}
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') closeComposer();
              // Ctrl/Cmd+Enter sends.
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                void handleSend();
              }
            }}
          />
          <div className="comment-layer__composer-actions">
            <button
              type="button"
              className="comment-layer__composer-cancel"
              onClick={closeComposer}
              disabled={sending}
            >
              Cancel
            </button>
            <button
              type="button"
              className="comment-layer__composer-send"
              onClick={() => void handleSend()}
              disabled={sending || !body.trim()}
            >
              {sending ? 'Sending…' : 'Send'}
            </button>
          </div>
        </div>
      )}
    </div>,
    document.body,
  );
}

const ADD_BTN_SIZE = 28;
const COMPOSER_WIDTH = 280;
const COMPOSER_EST_HEIGHT = 180;

function floatingAddButtonPosition(sel: SelectionState): { top: number; left: number } {
  let top = sel.rectBottom + 6;
  let left = sel.rectRight + 8;

  if (top + ADD_BTN_SIZE > window.innerHeight - 8) {
    top = sel.rectTop - ADD_BTN_SIZE - 6;
  }
  left = clamp(left, 8, window.innerWidth - ADD_BTN_SIZE - 8);
  top = clamp(top, 8, window.innerHeight - ADD_BTN_SIZE - 8);

  return { top, left };
}

function floatingComposerPosition(sel: SelectionState): { top: number; left: number } {
  let top = sel.rectBottom + 8;
  let left = sel.rectLeft;

  if (top + COMPOSER_EST_HEIGHT > window.innerHeight - 8) {
    top = sel.rectTop - COMPOSER_EST_HEIGHT - 8;
  }
  if (top < 8) top = 8;
  left = clamp(left, 8, window.innerWidth - COMPOSER_WIDTH - 8);

  return { top, left };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

/**
 * Walk up the DOM tree from `node` to find the nearest element that has
 * data-source-line-start (a rehype-annotated leaf-prose block).
 */
function findBlockElement(node: Node): Element | null {
  let el: Node | null = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  while (el && el instanceof Element) {
    if (el.hasAttribute('data-source-line-start')) return el;
    el = el.parentElement;
  }
  return null;
}

interface BlockAttrs {
  lineStart: number;
  colStart: number;
  lineEnd: number;
  colEnd: number;
}

function readBlockAttrs(el: Element): BlockAttrs | null {
  const lineStart = Number(el.getAttribute('data-source-line-start'));
  const colStart = Number(el.getAttribute('data-source-col-start'));
  const lineEnd = Number(el.getAttribute('data-source-line-end'));
  const colEnd = Number(el.getAttribute('data-source-col-end'));

  if (!lineStart || Number.isNaN(colStart) || !lineEnd || Number.isNaN(colEnd)) return null;

  return { lineStart, colStart, lineEnd, colEnd };
}

/**
 * Compute the character offsets of the selection's start and end within the
 * textContent of `blockEl`.
 *
 * Uses a TreeWalker to accumulate text-node lengths until we reach the
 * selection boundary nodes.
 */
function getSelectionOffsetsInElement(
  blockEl: Element,
  range: Range,
): { start: number; end: number } {
  let start = 0;
  let end = 0;
  let offset = 0;
  let foundStart = false;
  let foundEnd = false;

  const walker = document.createTreeWalker(blockEl, NodeFilter.SHOW_TEXT);

  let node = walker.nextNode();
  while (node) {
    const len = (node as Text).length;

    if (!foundStart) {
      if (node === range.startContainer) {
        start = offset + range.startOffset;
        foundStart = true;
      } else {
        // Check if startContainer is a child element whose text we just walked past.
      }
    }

    if (!foundEnd) {
      if (node === range.endContainer) {
        end = offset + range.endOffset;
        foundEnd = true;
      }
    }

    if (foundStart && foundEnd) break;

    offset += len;
    node = walker.nextNode();
  }

  // If start/end were not found via text nodes (e.g. element boundary), fall
  // back to 0..blockEl.textContent.length.
  if (!foundStart) start = 0;
  if (!foundEnd) end = blockEl.textContent?.length ?? 0;

  return { start, end };
}
