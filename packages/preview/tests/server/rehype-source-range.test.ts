/**
 * Verifies that rehypeSourceRange correctly annotates leaf-prose hast elements
 * with data-source-* attributes when run through the real @mdx-js/mdx pipeline.
 *
 * MDX position verification result: POSITIONS PRESENT (specced path taken).
 * Confirmed by live probe: @mdx-js/mdx@3.1.1 carries unified AST positions
 * through the rehype pass for standard markdown elements. Custom components
 * (mdxJsxFlowElement) do not surface as 'element' nodes and are not annotated.
 * Positions use `column` (0-indexed), which is numerically equal to our `col`.
 */

import { compile } from '@mdx-js/mdx';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import { visit } from 'unist-util-visit';
import { describe, expect, it } from 'vitest';

// Re-import the plugin under test from source (not compiled dist).
import { rehypeSourceRange } from '../../src/rehype-source-range.js';

// Inline structural types to match the MDX rehype pipeline — avoids needing
// @types/hast and unified in tsconfig.
interface HastElement {
  type: 'element';
  tagName: string;
  properties: Record<string, unknown>;
  position?: unknown;
  children: HastNode[];
}
interface HastRoot {
  type: 'root';
  children: HastNode[];
}
type HastNode = HastElement | { type: string; children?: HastNode[] };

const SAMPLE_MDX = `---
title: Test
---

# Heading one

A paragraph with some text.

- list item one
- list item two

<Status value="draft" />
`;

interface CapturedNode {
  tag: string;
  lineStart: number | undefined;
  colStart: number | undefined;
  lineEnd: number | undefined;
  colEnd: number | undefined;
}

async function compileAndCapture(mdxSource: string): Promise<CapturedNode[]> {
  const captured: CapturedNode[] = [];

  // Capture plugin runs AFTER rehypeSourceRange to inspect what it produced.
  function capturePlugin() {
    return (tree: HastRoot) => {
      visit(tree, 'element', (node: HastElement) => {
        const p = node.properties ?? {};
        const lineStart = p['data-source-line-start'];
        if (lineStart !== undefined) {
          captured.push({
            tag: node.tagName,
            lineStart: lineStart as number,
            colStart: p['data-source-col-start'] as number,
            lineEnd: p['data-source-line-end'] as number,
            colEnd: p['data-source-col-end'] as number,
          });
        }
      });
    };
  }

  await compile(mdxSource, {
    remarkPlugins: [[remarkFrontmatter, ['yaml']], remarkGfm],
    rehypePlugins: [rehypeSourceRange, capturePlugin],
  });

  return captured;
}

describe('rehypeSourceRange', () => {
  it('annotates h1 with correct data-source-* attributes', async () => {
    const nodes = await compileAndCapture(SAMPLE_MDX);
    const h1 = nodes.find((n) => n.tag === 'h1');
    expect(h1).toBeDefined();
    expect(typeof h1!.lineStart).toBe('number');
    expect(h1!.lineStart).toBeGreaterThan(0);
    expect(typeof h1!.colStart).toBe('number');
    expect(typeof h1!.lineEnd).toBe('number');
    expect(typeof h1!.colEnd).toBe('number');
  });

  it('annotates p with source position', async () => {
    const nodes = await compileAndCapture(SAMPLE_MDX);
    const p = nodes.find((n) => n.tag === 'p');
    expect(p).toBeDefined();
    expect(p!.lineStart).toBeGreaterThan(0);
  });

  it('annotates li items', async () => {
    const nodes = await compileAndCapture(SAMPLE_MDX);
    const liNodes = nodes.filter((n) => n.tag === 'li');
    expect(liNodes.length).toBe(2);
    for (const li of liNodes) {
      expect(li.lineStart).toBeGreaterThan(0);
    }
  });

  it('does NOT annotate custom component elements (tag starts with uppercase)', async () => {
    // In the MDX hast pipeline, JSX components surface as mdxJsxFlowElement,
    // not as 'element' nodes. Our /^[A-Z]/ guard provides belt-and-suspenders
    // coverage if any edge case produces an uppercase-tagName element node.
    const nodes = await compileAndCapture(SAMPLE_MDX);
    const customNodes = nodes.filter((n) => /^[A-Z]/.test(n.tag));
    expect(customNodes).toHaveLength(0);
  });

  it('line numbers are 1-indexed and columns are 0-indexed (non-negative)', async () => {
    const nodes = await compileAndCapture(SAMPLE_MDX);
    for (const n of nodes) {
      // Line numbers: 1-indexed
      expect(n.lineStart).toBeGreaterThanOrEqual(1);
      expect(n.lineEnd).toBeGreaterThanOrEqual(1);
      // Column numbers: 0-indexed (may be 0 for elements at start of line)
      expect(n.colStart).toBeGreaterThanOrEqual(0);
      expect(n.colEnd).toBeGreaterThanOrEqual(0);
    }
  });

  it('start position precedes or equals end position', async () => {
    const nodes = await compileAndCapture(SAMPLE_MDX);
    for (const n of nodes) {
      if (n.lineStart === n.lineEnd) {
        expect(n.colStart).toBeLessThanOrEqual(n.colEnd!);
      } else {
        expect(n.lineStart).toBeLessThan(n.lineEnd!);
      }
    }
  });

  it('does not annotate non-prose elements (ul, ol, div)', async () => {
    const mdx = '\n- item one\n- item two\n';
    const nodes = await compileAndCapture(mdx);
    const ulNodes = nodes.filter((n) => n.tag === 'ul' || n.tag === 'ol' || n.tag === 'div');
    expect(ulNodes).toHaveLength(0);
  });
});
