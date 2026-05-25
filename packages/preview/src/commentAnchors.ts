/**
 * Pure helpers for comment anchor computation and re-anchoring.
 * No DOM access lives here — only string/coordinate math.
 *
 * Reuses offsetToLineCol and findAnchor from the shared anchor module which
 * is explicitly safe to import client-side.
 *
 * Anchor approximation (v2 accepted limitation):
 *  In v2, prose has no inline marks, so a block's rendered textContent ≈ its
 *  source text. For single-line blocks (headings, most list items) the
 *  line/col mapping is exact. For soft-wrapped multi-line paragraphs the
 *  col offset is approximate because line breaks in the rendered DOM do not
 *  correspond 1:1 to source offsets. The `before+selected+after` context
 *  string is the drift-tolerant fallback for re-anchoring at render time.
 */

import type { CommentAnchor } from './api.js';
import { findAnchor, lineColToOffset, offsetToLineCol } from './server/anchor.js';

const CONTEXT_CHARS = 30;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Source-range data attributes emitted by rehype-source-range. */
export interface BlockSourceAttrs {
  lineStart: number;
  colStart: number;
  lineEnd: number;
  colEnd: number;
}

/** Result of re-anchoring a comment to current source. */
export type AnchorResolveResult =
  | { kind: 'exact'; startOffset: number; endOffset: number }
  | { kind: 'context'; startOffset: number; endOffset: number }
  | { kind: 'stale' };

// ---------------------------------------------------------------------------
// computeAnchor
// ---------------------------------------------------------------------------

/**
 * Compute a CommentAnchor from:
 *  - The full source text of the file (needed to convert offsets → line/col).
 *  - The block's source attrs (data-source-line-start etc).
 *  - The selection's character offset within the block's textContent.
 *
 * The caller (CommentLayer) reads the DOM; this function does the math.
 */
export function computeAnchor(
  fileSource: string,
  block: BlockSourceAttrs,
  selectionStartInBlock: number,
  selectionEndInBlock: number,
  selectedText: string,
  blockTextContent: string,
): CommentAnchor {
  // Convert the block's source-start to an absolute byte offset in the file.
  const blockStartOffset = lineColToOffset(fileSource, block.lineStart, block.colStart);

  // The selection's offsets within the block map (approximately) to the same
  // positions in the source. See module-level comment for the v2 approximation.
  const selAbsStart = blockStartOffset + selectionStartInBlock;
  const selAbsEnd = blockStartOffset + selectionEndInBlock;

  const { line: lineStart, col: colStart } = offsetToLineCol(fileSource, selAbsStart);
  const { line: lineEnd, col: colEnd } = offsetToLineCol(fileSource, selAbsEnd);

  // Context strings: up to CONTEXT_CHARS around the selection within the
  // block's textContent. We use textContent (≈ source) for context.
  const before = blockTextContent.slice(
    Math.max(0, selectionStartInBlock - CONTEXT_CHARS),
    selectionStartInBlock,
  );
  const after = blockTextContent.slice(selectionEndInBlock, selectionEndInBlock + CONTEXT_CHARS);

  return {
    lineStart,
    colStart,
    lineEnd,
    colEnd,
    before,
    selected: selectedText,
    after,
  };
}

// ---------------------------------------------------------------------------
// resolveAnchor
// ---------------------------------------------------------------------------

/**
 * Re-anchor a comment against current file source.
 *
 * Strategy (per spec "Anchor re-rendering"):
 *  1. Try line/col span. If the text at that span equals anchor.selected → exact match.
 *  2. Else try findAnchor (before+selected+after context search). If unique → context match.
 *  3. Otherwise → stale.
 */
export function resolveAnchor(fileSource: string, anchor: CommentAnchor): AnchorResolveResult {
  // Step 1: direct line/col lookup.
  try {
    const start = lineColToOffset(fileSource, anchor.lineStart, anchor.colStart);
    const end = lineColToOffset(fileSource, anchor.lineEnd, anchor.colEnd);
    const span = fileSource.slice(start, end);
    if (span === anchor.selected) {
      return { kind: 'exact', startOffset: start, endOffset: end };
    }
  } catch {
    // Out-of-range line/col after heavy edits — fall through to context search.
  }

  // Step 2: context string search.
  const found = findAnchor(fileSource, {
    before: anchor.before,
    selected: anchor.selected,
    after: anchor.after,
  });

  if (found !== null) {
    return { kind: 'context', startOffset: found.start, endOffset: found.end };
  }

  // Step 3: stale.
  return { kind: 'stale' };
}
