/**
 * Pure anchor utilities — no I/O. Safe to import on the client side too.
 *
 * Line numbers are 1-indexed. Column numbers are 0-indexed. This matches the
 * unified AST `position` convention used throughout the MDX pipeline.
 */

/**
 * Convert a (line, col) pair to a byte offset within `text`.
 *
 * @param text   - The full source string.
 * @param line   - 1-indexed line number.
 * @param col    - 0-indexed column (byte offset from the start of the line).
 * @returns The absolute byte offset into `text`.
 * @throws If the requested line does not exist in `text`.
 */
export function lineColToOffset(text: string, line: number, col: number): number {
  if (line < 1) throw new Error(`lineColToOffset: line must be >= 1, got ${line}`);
  if (col < 0) throw new Error(`lineColToOffset: col must be >= 0, got ${col}`);

  let offset = 0;
  let currentLine = 1;

  while (currentLine < line) {
    const nl = text.indexOf('\n', offset);
    if (nl === -1) {
      throw new Error(
        `lineColToOffset: text has only ${currentLine - 1} lines, requested line ${line}`,
      );
    }
    offset = nl + 1;
    currentLine++;
  }

  const result = offset + col;
  if (result > text.length) {
    throw new Error(
      `lineColToOffset: offset ${result} exceeds text length ${text.length} (line ${line}, col ${col})`,
    );
  }
  return result;
}

/**
 * Convert an absolute byte offset into `text` to a (line, col) pair.
 *
 * @param text   - The full source string.
 * @param offset - Byte offset (0-indexed, inclusive).
 * @returns `{ line, col }` where line is 1-indexed and col is 0-indexed.
 */
export function offsetToLineCol(text: string, offset: number): { line: number; col: number } {
  if (offset < 0 || offset > text.length) {
    throw new Error(`offsetToLineCol: offset ${offset} is out of range [0, ${text.length}]`);
  }

  let line = 1;
  let lastNl = -1;

  for (let i = 0; i < offset; i++) {
    if (text[i] === '\n') {
      line++;
      lastNl = i;
    }
  }

  return { line, col: offset - lastNl - 1 };
}

/**
 * Attempt to find the unique location of an anchor in source text.
 *
 * Uses the `before + selected + after` context string to locate the selection.
 * Returns `null` when the combined pattern occurs zero or more than once — both
 * are treated as "stale" (ambiguous / not found).
 *
 * @param text   - The full source string.
 * @param anchor - Context object with `before`, `selected`, and `after` strings.
 * @returns `{ start, end }` byte offsets of `selected` within `text`, or `null`.
 */
export function findAnchor(
  text: string,
  anchor: { before: string; selected: string; after: string },
): { start: number; end: number } | null {
  const { before, selected, after } = anchor;
  const needle = before + selected + after;

  let firstIdx = -1;
  let count = 0;
  let searchFrom = 0;

  while (true) {
    const idx = text.indexOf(needle, searchFrom);
    if (idx === -1) break;
    count++;
    if (count === 1) {
      firstIdx = idx;
    } else {
      // More than one match — ambiguous, treat as stale.
      return null;
    }
    searchFrom = idx + 1;
  }

  if (count === 0 || firstIdx === -1) return null;

  const start = firstIdx + before.length;
  const end = start + selected.length;
  return { start, end };
}
