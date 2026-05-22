import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import GithubSlugger from 'github-slugger';
import JSON5 from 'json5';
import remarkMdx from 'remark-mdx';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import { visit } from 'unist-util-visit';

export interface ParsedComponent {
  name: string;
  attributes: Record<string, unknown>;
  /** Names of attributes that couldn't be parsed (validator will warn). */
  unparsedAttributes: string[];
  line?: number;
  column?: number;
}

export interface ParsedSpec {
  /** Filename without extension. */
  slug: string;
  filePath: string;
  /** Slugs of every heading in the file (deduped per file by github-slugger). */
  headingSlugs: Set<string>;
  /** Components used in the file. */
  components: ParsedComponent[];
}

const processor = unified().use(remarkParse).use(remarkMdx);

function extractText(node: unknown): string {
  if (!node || typeof node !== 'object') return '';
  const n = node as { value?: string; children?: unknown[] };
  if (typeof n.value === 'string') return n.value;
  if (Array.isArray(n.children)) {
    return n.children.map(extractText).join('');
  }
  return '';
}

type MdxAttribute = {
  type: 'mdxJsxAttribute';
  name: string;
  value?: string | { value: string } | null;
};

/**
 * Convert a JSX attribute value to a JS value for validation. Uses JSON5
 * (no eval) which accepts JS-style object literals, single quotes,
 * unquoted keys, trailing commas, and comments — covering the syntax
 * MDX authors realistically write.
 *
 * Returns `undefined` when the expression cannot be parsed as a literal;
 * the validator surfaces this as a warning (it can't enforce the schema
 * for non-literal expressions).
 */
function attributeValueToJs(value: MdxAttribute['value']): {
  parsed: boolean;
  value: unknown;
} {
  if (value == null) return { parsed: true, value: true };
  if (typeof value === 'string') return { parsed: true, value };
  const expr = value.value;
  if (typeof expr !== 'string') return { parsed: false, value: undefined };
  const trimmed = expr.trim();
  try {
    return { parsed: true, value: JSON5.parse(trimmed) };
  } catch {
    return { parsed: false, value: undefined };
  }
}

export function parseSpec(filePath: string): ParsedSpec {
  const source = readFileSync(filePath, 'utf8');
  const tree = processor.parse(source);
  const slug = basename(filePath).replace(/\.mdx?$/i, '');
  const slugger = new GithubSlugger();
  const headingSlugs = new Set<string>();
  const components: ParsedComponent[] = [];

  visit(tree, (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    const n = node as {
      type: string;
      depth?: number;
      name?: string;
      attributes?: MdxAttribute[];
      position?: { start?: { line?: number; column?: number } };
    };
    if (n.type === 'heading') {
      const text = extractText(node);
      const headingSlug = slugger.slug(text);
      headingSlugs.add(headingSlug);
      return;
    }
    if (n.type === 'mdxJsxFlowElement' || n.type === 'mdxJsxTextElement') {
      if (!n.name) return;
      const attrs: Record<string, unknown> = {};
      const unparsed: string[] = [];
      for (const attr of n.attributes ?? []) {
        if (attr.type !== 'mdxJsxAttribute') continue;
        const { parsed, value } = attributeValueToJs(attr.value);
        if (parsed) {
          attrs[attr.name] = value;
        } else {
          unparsed.push(attr.name);
        }
      }
      components.push({
        name: n.name,
        attributes: attrs,
        unparsedAttributes: unparsed,
        line: n.position?.start?.line,
        column: n.position?.start?.column,
      });
    }
  });

  return { slug, filePath, headingSlugs, components };
}
