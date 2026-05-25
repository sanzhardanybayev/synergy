/**
 * Map comment anchors to DOM ranges inside .mdx-body.
 * Pure DOM + string math; no React.
 */

import type { Comment } from './api.js';
import { resolveAnchor } from './commentAnchors.js';
import { lineColToOffset } from './server/anchor.js';

export interface BlockSourceSpan {
  start: number;
  end: number;
}

export interface LocatedComment {
  comment: Comment;
  kind: 'exact' | 'context' | 'stale';
  range: Range | null;
}

export function getBlockSourceSpan(fileSource: string, el: Element): BlockSourceSpan | null {
  const lineStart = Number(el.getAttribute('data-source-line-start'));
  const colStart = Number(el.getAttribute('data-source-col-start'));
  const lineEnd = Number(el.getAttribute('data-source-line-end'));
  const colEnd = Number(el.getAttribute('data-source-col-end'));

  if (!lineStart || Number.isNaN(colStart) || !lineEnd || Number.isNaN(colEnd)) return null;

  try {
    return {
      start: lineColToOffset(fileSource, lineStart, colStart),
      end: lineColToOffset(fileSource, lineEnd, colEnd),
    };
  } catch {
    return null;
  }
}

export function findBlockForOffset(
  mdxBody: Element,
  fileSource: string,
  offset: number,
): Element | null {
  for (const block of mdxBody.querySelectorAll('[data-source-line-start]')) {
    const span = getBlockSourceSpan(fileSource, block);
    if (span && offset >= span.start && offset <= span.end) {
      return block;
    }
  }
  return null;
}

/**
 * Build a DOM Range for character offsets within a block's textContent.
 */
export function createRangeInBlock(
  blockEl: Element,
  startOffset: number,
  endOffset: number,
): Range | null {
  const textLen = blockEl.textContent?.length ?? 0;
  if (startOffset < 0 || endOffset > textLen || startOffset >= endOffset) return null;

  const range = document.createRange();
  let offset = 0;
  let foundStart = false;
  let foundEnd = false;

  const walker = document.createTreeWalker(blockEl, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();

  while (node) {
    const len = (node as Text).length;

    if (!foundStart && offset + len >= startOffset) {
      range.setStart(node, startOffset - offset);
      foundStart = true;
    }

    if (!foundEnd && offset + len >= endOffset) {
      range.setEnd(node, endOffset - offset);
      foundEnd = true;
    }

    if (foundStart && foundEnd) break;
    offset += len;
    node = walker.nextNode();
  }

  if (!foundStart || !foundEnd) return null;
  return range;
}

export function locateCommentInDom(
  mdxBody: Element,
  fileSource: string,
  comment: Comment,
): LocatedComment {
  const resolved = resolveAnchor(fileSource, comment.anchor);
  if (resolved.kind === 'stale') {
    return { comment, kind: 'stale', range: null };
  }

  const block = findBlockForOffset(mdxBody, fileSource, resolved.startOffset);
  if (!block) {
    return { comment, kind: 'stale', range: null };
  }

  const blockSpan = getBlockSourceSpan(fileSource, block);
  if (!blockSpan) {
    return { comment, kind: 'stale', range: null };
  }

  const startInBlock = resolved.startOffset - blockSpan.start;
  const endInBlock = resolved.endOffset - blockSpan.start;
  const range = createRangeInBlock(block, startInBlock, endInBlock);

  if (!range) {
    return { comment, kind: 'stale', range: null };
  }

  return { comment, kind: resolved.kind, range };
}

/** Client rects for a range, for fixed-position overlays. */
export function getRangeClientRects(range: Range): DOMRect[] {
  const rects: DOMRect[] = [];
  for (const rect of range.getClientRects()) {
    if (rect.width > 0 || rect.height > 0) {
      rects.push(rect);
    }
  }
  if (rects.length === 0) {
    const fallback = range.getBoundingClientRect();
    if (fallback.width > 0 || fallback.height > 0) {
      rects.push(fallback);
    }
  }
  return rects;
}

/** Anchor point for a comment bubble — top-right of the selection union box. */
export function getMarkerPosition(rects: DOMRect[]): { top: number; left: number } | null {
  if (rects.length === 0) return null;

  let top = rects[0]!.top;
  let right = rects[0]!.right;
  let bottom = rects[0]!.bottom;

  for (const rect of rects.slice(1)) {
    top = Math.min(top, rect.top);
    right = Math.max(right, rect.right);
    bottom = Math.max(bottom, rect.bottom);
  }

  return { top, left: right + 8 };
}
