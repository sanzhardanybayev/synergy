/**
 * Syntax highlighting for the review panes.
 *
 * The tokenizer is async (grammars load on first use of a language), so every row renders its plain
 * captured text first and swaps in token spans when they arrive. Highlighting therefore never gates
 * first paint, and a failure to tokenize is indistinguishable from a slow one: the reviewer still
 * sees the exact captured line.
 *
 * All grammar, theme and diff-side logic lives in `@synergy/review-core/highlight`, shared with the
 * VS Code review pane.
 */

import {
  type HighlightHunkRow,
  type HighlightedLine,
  highlightHunk,
  highlightLines,
  resolveLanguage,
} from '@synergy/review-core/highlight';
import { useEffect, useState } from 'react';
import { useThemeMode } from '../useThemeMode.js';

/** Tokens for a whole file, keyed by zero-based line index. `undefined` until they resolve. */
export function useHighlightedFile(path: string, text: string): HighlightedLine[] | undefined {
  const mode = useThemeMode();
  const [lines, setLines] = useState<HighlightedLine[]>();

  useEffect(() => {
    let active = true;
    setLines(undefined);
    void highlightLines(text, resolveLanguage(path), mode).then((next) => {
      if (active) setLines(next);
    });
    return () => {
      active = false;
    };
  }, [path, text, mode]);

  return lines;
}

/** Tokens for a diff hunk, keyed by row index. `undefined` until they resolve. */
export function useHighlightedHunk(
  path: string,
  rows: readonly HighlightHunkRow[],
): HighlightedLine[] | undefined {
  const mode = useThemeMode();
  const [lines, setLines] = useState<HighlightedLine[]>();
  // Callers re-derive `rows` on every render, so its identity is useless as a dependency. Rows are
  // immutable per review item, which makes their serialized content the real identity - and that
  // string is genuinely all the effect depends on, so no dependency has to be suppressed.
  const rowsJson = JSON.stringify(rows.map((row) => [row.kind, row.text]));

  useEffect(() => {
    let active = true;
    setLines(undefined);
    const parsed = (JSON.parse(rowsJson) as [HighlightHunkRow['kind'], string][]).map(
      ([kind, text]) => ({ kind, text }),
    );
    void highlightHunk(parsed, resolveLanguage(path), mode).then((next) => {
      if (active) setLines(next);
    });
    return () => {
      active = false;
    };
  }, [path, rowsJson, mode]);

  return lines;
}

interface CodeLineProps {
  text: string;
  tokens?: HighlightedLine;
}

/** Renders one code line: token spans when available, the plain captured text otherwise. */
export function CodeLine({ text, tokens }: CodeLineProps) {
  if (!tokens || tokens.length === 0) return <code>{text || ' '}</code>;
  return (
    <code>
      {tokens.map((token, index) => (
        <span
          // Tokens have no identity beyond their position within an immutable line.
          // biome-ignore lint/suspicious/noArrayIndexKey: position is the identity here.
          key={index}
          style={{
            color: token.color,
            fontStyle: token.italic ? 'italic' : undefined,
            fontWeight: token.bold ? 600 : undefined,
          }}
        >
          {token.text}
        </span>
      ))}
    </code>
  );
}
