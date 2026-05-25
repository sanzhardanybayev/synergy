/**
 * Rehype plugin: copy `node.position` onto leaf-prose HTML elements as
 * `data-source-*` attributes so the browser can map rendered DOM nodes back
 * to their MDX source range for the inline-edit and selection-anchor features.
 *
 * Annotated attributes (all numeric):
 *   data-source-line-start   — 1-indexed start line
 *   data-source-col-start    — 0-indexed start column (byte offset within line)
 *   data-source-line-end     — 1-indexed end line
 *   data-source-col-end      — 0-indexed end column
 *
 * Leaf-prose elements annotated:
 *   p, li, h1, h2, h3, h4, h5, h6, blockquote, strong, em, code
 *
 * Elements whose tagName matches /^[A-Z]/ (MDX custom components) are NOT
 * annotated — their props are managed by the spec-kit, not the edit buffer.
 * The plugin still recurses into their children.
 *
 * Position verification: the MDX pipeline via @mdx-js/mdx@3.x carries unified
 * AST positions through the rehype pass unchanged. Positions use `column`
 * (0-indexed) not `col`. Both confirmed by a live probe against the real
 * pipeline (see rehype-source-range.test.ts).
 */

import { visit } from 'unist-util-visit';

// Inline structural types to avoid @types/hast and unified in tsconfig types.
// These shapes match the actual runtime values from the MDX rehype pipeline.

interface HastPosition {
  start: { line: number; column: number; offset?: number };
  end: { line: number; column: number; offset?: number };
}

interface HastElement {
  type: 'element';
  tagName: string;
  properties: Record<string, unknown>;
  position?: HastPosition;
  children: HastNode[];
}

interface HastRoot {
  type: 'root';
  children: HastNode[];
}

type HastNode = HastElement | { type: string; children?: HastNode[] };

const LEAF_PROSE_TAGS = new Set([
  'p',
  'li',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'blockquote',
  'strong',
  'em',
  'code',
]);

/**
 * Rehype plugin that annotates leaf-prose elements with source position data
 * attributes derived from the unified `node.position` carried through the MDX
 * compilation pipeline.
 */
export function rehypeSourceRange() {
  return (tree: HastRoot) => {
    visit(tree, 'element', (node: HastElement) => {
      const { tagName, position } = node;

      // Skip custom components (tagName starts with uppercase).
      // Note: in hast produced by @mdx-js/mdx, JSX custom components surface
      // as mdxJsxFlowElement / mdxJsxTextElement, not as 'element' nodes, so
      // this guard is a belt-and-suspenders check for any edge cases.
      if (/^[A-Z]/.test(tagName)) return;

      if (!LEAF_PROSE_TAGS.has(tagName)) return;

      if (!position) return;

      // unified positions use `column` (0-indexed). The spec and anchor.ts both
      // use `col` (0-indexed). They are numerically identical — just rename here.
      const { start, end } = position;

      if (!node.properties) node.properties = {};

      node.properties['data-source-line-start'] = start.line;
      node.properties['data-source-col-start'] = start.column;
      node.properties['data-source-line-end'] = end.line;
      node.properties['data-source-col-end'] = end.column;
    });
  };
}
