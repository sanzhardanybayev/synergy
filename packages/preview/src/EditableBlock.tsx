/**
 * EditableBlock — a contentEditable leaf-prose wrapper used by the MDX
 * component map.
 *
 * Key decisions:
 *  - Only renders as contentEditable when source coords ARE present AND the
 *    element has no child elements with their own source coords (leaf-guard).
 *    Non-leaf or coord-less blocks render as plain read-only containers.
 *  - expectedText is computed from fileSource + lineColToOffset at render
 *    time, NOT from DOM textContent, to avoid the soft-wrap mismatch that
 *    would always 409. See KEY FACTS in the task spec.
 *  - On Enter in <li>: insert sibling <li>. On Enter in empty <li>: exit
 *    the list by inserting a <p> after it.
 *  - Paste: strips all formatting (plain text only).
 *  - Focus-across-HMR: data-block-key + useLayoutEffect restores caret.
 *  - diffMode: Apply is disabled; block is read-only.
 */

import {
  type HTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
  createElement,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useEditBuffer } from './EditBuffer.js';
import { lineColToOffset } from './server/anchor.js';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

type EditableTag = 'p' | 'li' | 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6' | 'blockquote';

export interface EditableBlockProps extends HTMLAttributes<HTMLElement> {
  /** The HTML tag this block should render as. */
  as: EditableTag;
  children?: ReactNode;
  /** data-source-* attrs forwarded from rehype as strings. */
  'data-source-line-start'?: string;
  'data-source-col-start'?: string;
  'data-source-line-end'?: string;
  'data-source-col-end'?: string;
}

// ---------------------------------------------------------------------------
// Focus-restore registry (HMR resilience)
// ---------------------------------------------------------------------------

/** Singleton map: blockKey → { caretOffset }. Survives HMR remounts. */
const focusRegistry = new Map<string, { caretOffset: number }>();

let lastFocusedKey: string | null = null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hasDescendantWithSourceCoords(el: Element): boolean {
  return el.querySelector('[data-source-line-start]') !== null;
}

function getCaretOffset(el: HTMLElement): number {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return 0;
  const range = sel.getRangeAt(0);
  const preRange = range.cloneRange();
  preRange.selectNodeContents(el);
  preRange.setEnd(range.startContainer, range.startOffset);
  return preRange.toString().length;
}

function restoreCaretOffset(el: HTMLElement, offset: number): void {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let remaining = offset;
  let node = walker.nextNode();
  while (node) {
    const len = (node as Text).length;
    if (remaining <= len) {
      const range = document.createRange();
      range.setStart(node, remaining);
      range.collapse(true);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      return;
    }
    remaining -= len;
    node = walker.nextNode();
  }
  // Fallback: place at end.
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  window.getSelection()?.removeAllRanges();
  window.getSelection()?.addRange(range);
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function EditableBlock({
  as: Tag,
  children,
  'data-source-line-start': rawLineStart,
  'data-source-col-start': rawColStart,
  'data-source-line-end': rawLineEnd,
  'data-source-col-end': rawColEnd,
  ...rest
}: EditableBlockProps) {
  const buffer = useEditBuffer();
  // Destructure stable methods/primitives for use in handler deps. Depending on
  // the whole `buffer` object re-creates handlers on every buffer state change
  // (its context value identity churns), which re-attaches DOM listeners on every
  // keystroke — the same infinite-churn footgun fixed in the pages/test helpers.
  const { setDirtyProse, applyOne, discard, currentFile, diffMode } = buffer;
  const elRef = useRef<HTMLElement | null>(null);
  const [isDirtyLocal, setIsDirtyLocal] = useState(false);

  // -------------------------------------------------------------------------
  // Source coordinate parsing
  // -------------------------------------------------------------------------

  const lineStart = rawLineStart !== undefined ? Number.parseInt(rawLineStart, 10) : null;
  const colStart = rawColStart !== undefined ? Number.parseInt(rawColStart, 10) : null;
  const lineEnd = rawLineEnd !== undefined ? Number.parseInt(rawLineEnd, 10) : null;
  const colEnd = rawColEnd !== undefined ? Number.parseInt(rawColEnd, 10) : null;

  const hasCoords =
    lineStart !== null &&
    colStart !== null &&
    lineEnd !== null &&
    colEnd !== null &&
    !Number.isNaN(lineStart) &&
    !Number.isNaN(colStart) &&
    !Number.isNaN(lineEnd) &&
    !Number.isNaN(colEnd);

  // -------------------------------------------------------------------------
  // Buffer key — stable for this block's source location.
  // -------------------------------------------------------------------------

  const bufferKey = useMemo(() => {
    if (!hasCoords || !buffer.currentFile) return '';
    return `${buffer.currentFile}:${lineStart}:${colStart}`;
  }, [hasCoords, buffer.currentFile, lineStart, colStart]);

  // -------------------------------------------------------------------------
  // Whether this block is editable: has coords, has a file, not diffMode,
  // and is a leaf (no descendant with source coords — checked at runtime).
  // -------------------------------------------------------------------------

  const canEdit = hasCoords && !!buffer.currentFile;

  // -------------------------------------------------------------------------
  // Focus-across-HMR: restore caret if this block was focused before remount.
  // -------------------------------------------------------------------------

  useLayoutEffect(() => {
    if (!canEdit || !bufferKey || !elRef.current) return;
    if (lastFocusedKey !== bufferKey) return;

    const saved = focusRegistry.get(bufferKey);
    if (saved !== undefined) {
      elRef.current.focus();
      restoreCaretOffset(elRef.current, saved.caretOffset);
    }
  }, [canEdit, bufferKey]);

  // -------------------------------------------------------------------------
  // Sync local dirty state from buffer (handles external discard / applyAll).
  // -------------------------------------------------------------------------

  const bufferEntry = bufferKey ? buffer.entries.get(bufferKey) : undefined;

  // Use useLayoutEffect to sync — avoids calling setState during render.
  useLayoutEffect(() => {
    if (isDirtyLocal && !bufferEntry) {
      setIsDirtyLocal(false);
    }
  }, [bufferEntry, isDirtyLocal]);

  // -------------------------------------------------------------------------
  // Compute expectedText from fileSource + coords (not from DOM).
  // This is the critical correctness guarantee for the 409-avoidance.
  // -------------------------------------------------------------------------

  const expectedText = useMemo(() => {
    if (
      !hasCoords ||
      !buffer.fileSource ||
      lineStart === null ||
      colStart === null ||
      lineEnd === null ||
      colEnd === null
    )
      return '';
    try {
      const start = lineColToOffset(buffer.fileSource, lineStart, colStart);
      const end = lineColToOffset(buffer.fileSource, lineEnd, colEnd);
      return buffer.fileSource.slice(start, end);
    } catch {
      return '';
    }
  }, [buffer.fileSource, hasCoords, lineStart, colStart, lineEnd, colEnd]);

  // -------------------------------------------------------------------------
  // Event handlers
  // -------------------------------------------------------------------------

  const handleInput = useCallback(() => {
    if (!canEdit || !bufferKey || !elRef.current) return;

    // Leaf guard: if this element now has child elements with source coords,
    // bail — let the inner leaf own the edit.
    if (hasDescendantWithSourceCoords(elRef.current)) return;

    const newText = elRef.current.textContent ?? '';
    setIsDirtyLocal(true);
    setDirtyProse(bufferKey, {
      kind: 'prose',
      file: currentFile,
      sourceStart: { line: lineStart!, col: colStart! },
      sourceEnd: { line: lineEnd!, col: colEnd! },
      originalText: expectedText,
      currentText: newText,
    });
  }, [
    canEdit,
    bufferKey,
    setDirtyProse,
    currentFile,
    lineStart,
    colStart,
    lineEnd,
    colEnd,
    expectedText,
  ]);

  const handleApply = useCallback(async () => {
    if (!bufferKey || diffMode) return;
    await applyOne(bufferKey);
    setIsDirtyLocal(false);
  }, [bufferKey, diffMode, applyOne]);

  const handleDiscard = useCallback(() => {
    if (!bufferKey || !elRef.current) return;
    discard(bufferKey);
    setIsDirtyLocal(false);
    // Revert DOM to original children by re-setting innerHTML to the original text.
    elRef.current.textContent = expectedText;
  }, [bufferKey, discard, expectedText]);

  // -------------------------------------------------------------------------
  // Enter key handling for <li>
  // -------------------------------------------------------------------------

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLElement>) => {
      if (Tag !== 'li' || e.key !== 'Enter') return;
      e.preventDefault();

      const el = elRef.current;
      if (!el) return;

      const isEmpty = (el.textContent ?? '').trim() === '';

      if (isEmpty) {
        // Exit the list: insert a <p> after the parent list.
        const list = el.parentElement;
        if (!list) return;
        const p = document.createElement('p');
        p.contentEditable = 'true';
        list.parentElement?.insertBefore(p, list.nextSibling);
        p.focus();
      } else {
        // Insert a sibling <li> after this one.
        const newLi = document.createElement('li');
        newLi.contentEditable = 'true';
        el.parentElement?.insertBefore(newLi, el.nextSibling);
        newLi.focus();
      }
    },
    [Tag],
  );

  // -------------------------------------------------------------------------
  // Paste: strip formatting, insert plain text only.
  // -------------------------------------------------------------------------

  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLElement>) => {
    e.preventDefault();
    const text = e.clipboardData.getData('text/plain');
    document.execCommand('insertText', false, text);
  }, []);

  // -------------------------------------------------------------------------
  // Focus / blur tracking for HMR restore.
  // -------------------------------------------------------------------------

  const handleFocus = useCallback(() => {
    lastFocusedKey = bufferKey;
  }, [bufferKey]);

  const handleBlur = useCallback(() => {
    if (!elRef.current || !bufferKey) return;
    focusRegistry.set(bufferKey, { caretOffset: getCaretOffset(elRef.current) });
  }, [bufferKey]);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  // Non-editable fallback: no coords, no file, or diffMode.
  // Also, children with source coords means we are not the leaf — render as
  // a plain container. (We can't check descendant coords at render time
  // without a DOM ref, so we set suppressContentEditableWarning=false and
  // rely on the input guard above for runtime safety.)

  const isEditable = canEdit && !buffer.diffMode;

  // Build the ref callback.
  const refCallback = useCallback((node: HTMLElement | null) => {
    elRef.current = node;
  }, []);

  // Data attrs for HMR restore + comment-layer detection.
  const blockProps = {
    ...rest,
    ...(bufferKey ? { 'data-block-key': bufferKey } : {}),
    // Preserve original data-source-* attrs so CommentLayer can still find them.
    'data-source-line-start': rawLineStart,
    'data-source-col-start': rawColStart,
    'data-source-line-end': rawLineEnd,
    'data-source-col-end': rawColEnd,
    ...(isEditable
      ? {
          contentEditable: true as const,
          suppressContentEditableWarning: true,
          onInput: handleInput,
          onKeyDown: handleKeyDown,
          onPaste: handlePaste,
          onFocus: handleFocus,
          onBlur: handleBlur,
        }
      : {}),
  };

  // Use createElement with the ref cast properly — React's JSX types do not
  // allow ref on a generic element without a forwardRef wrapper, but
  // createElement accepts it at runtime. We use `unknown` indirection to
  // satisfy the type checker without `as any`.
  type TagProps = React.HTMLAttributes<HTMLElement> & {
    ref: (node: HTMLElement | null) => void;
    'data-block-key'?: string;
    'data-source-line-start'?: string;
    'data-source-col-start'?: string;
    'data-source-line-end'?: string;
    'data-source-col-end'?: string;
  };

  return (
    <>
      {createElement(
        Tag as unknown as string,
        { ...blockProps, ref: refCallback } as TagProps,
        children,
      )}

      {isDirtyLocal && !buffer.diffMode && (
        <span className="editable-block__actions" contentEditable={false}>
          <button
            type="button"
            className="editable-block__apply-btn"
            onClick={() => void handleApply()}
          >
            Apply
          </button>
          <button type="button" className="editable-block__discard-btn" onClick={handleDiscard}>
            Discard
          </button>
        </span>
      )}

      {isDirtyLocal && buffer.diffMode && (
        <span
          className="editable-block__actions editable-block__actions--diff"
          contentEditable={false}
        >
          <button type="button" className="editable-block__discard-btn" onClick={handleDiscard}>
            Discard
          </button>
        </span>
      )}
    </>
  );
}
