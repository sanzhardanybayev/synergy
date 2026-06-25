import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import remarkMdx from 'remark-mdx';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import { visit } from 'unist-util-visit';
import { resolveSessionsRelative } from './paths.js';

export interface AgentTreeNodeLike {
  name: string;
  type: string;
  teamName?: string;
  responsibility?: string;
  model?: string;
  effort?: string;
  count?: number;
  subAgents?: AgentTreeNodeLike[];
}

export class TreeValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TreeValidationError';
  }
}

const VALID_TYPES = new Set(['sub-agent', 'agent-team', 'orchestrator']);
const VALID_MODELS = new Set(['opus', 'sonnet', 'haiku']);
const VALID_EFFORTS = new Set(['low', 'medium', 'high', 'max']);

type Result =
  | { ok: true }
  | { ok: false; reason: 'not_found' | 'no_agent_tree' | 'invalid' | 'error'; detail?: string };

function serializeNode(n: AgentTreeNodeLike): string {
  if (typeof n.name !== 'string' || n.name.length === 0) {
    throw new TreeValidationError('node.name must be a non-empty string');
  }
  if (!n.type || !VALID_TYPES.has(n.type)) {
    throw new TreeValidationError(
      `node.type must be one of ${[...VALID_TYPES].join(', ')}; got ${JSON.stringify(n.type)}`,
    );
  }

  const parts: string[] = [`name: ${JSON.stringify(n.name)}`, `type: '${n.type}'`];

  if (n.teamName !== undefined) {
    if (typeof n.teamName !== 'string') {
      throw new TreeValidationError('node.teamName must be a string');
    }
    parts.push(`teamName: ${JSON.stringify(n.teamName)}`);
  }

  if (n.responsibility !== undefined) {
    if (typeof n.responsibility !== 'string') {
      throw new TreeValidationError('node.responsibility must be a string');
    }
    parts.push(`responsibility: ${JSON.stringify(n.responsibility)}`);
  }

  if (n.model !== undefined) {
    if (!VALID_MODELS.has(n.model)) {
      throw new TreeValidationError(
        `node.model must be one of ${[...VALID_MODELS].join(', ')}; got ${JSON.stringify(n.model)}`,
      );
    }
    parts.push(`model: '${n.model}'`);
  }

  if (n.effort !== undefined) {
    if (!VALID_EFFORTS.has(n.effort)) {
      throw new TreeValidationError(
        `node.effort must be one of ${[...VALID_EFFORTS].join(', ')}; got ${JSON.stringify(n.effort)}`,
      );
    }
    parts.push(`effort: '${n.effort}'`);
  }

  if (n.count !== undefined) {
    if (typeof n.count !== 'number' || !Number.isFinite(n.count)) {
      throw new TreeValidationError('node.count must be a finite number');
    }
    parts.push(`count: ${n.count}`);
  }

  if (Array.isArray(n.subAgents) && n.subAgents.length > 0) {
    parts.push(`subAgents: ${serializeTree(n.subAgents)}`);
  }

  return `{ ${parts.join(', ')} }`;
}

export function serializeTree(nodes: AgentTreeNodeLike[]): string {
  if (!Array.isArray(nodes)) {
    throw new TreeValidationError('tree must be an array');
  }
  return `[${nodes.map(serializeNode).join(', ')}]`;
}

export async function handleAgentTreePut(
  sessionsDir: string,
  body: { file: string; tree: unknown },
): Promise<Result> {
  if (!Array.isArray(body.tree)) {
    return { ok: false, reason: 'invalid', detail: 'body.tree must be an array' };
  }

  let absPath: string;
  try {
    absPath = resolveSessionsRelative(sessionsDir, body.file);
  } catch (err) {
    return { ok: false, reason: 'error', detail: String(err) };
  }
  if (!existsSync(absPath)) return { ok: false, reason: 'not_found' };

  const source = readFileSync(absPath, 'utf8');
  const ast = unified().use(remarkParse).use(remarkMdx).parse(source);

  let attrStart: number | null = null;
  let attrEnd: number | null = null;

  visit(ast, 'mdxJsxFlowElement', (node: unknown) => {
    const el = node as {
      name?: string;
      attributes?: Array<{
        type: string;
        name?: string;
        value?: { type?: string; data?: { estree?: { range?: number[] } } };
      }>;
    };
    if (el.name !== 'AgentTree' || attrStart !== null) return;
    const attr = (el.attributes ?? []).find(
      (a) => a.type === 'mdxJsxAttribute' && a.name === 'nodes',
    );
    if (attr?.value?.type !== 'mdxJsxAttributeValueExpression') return;
    // attr.value.position is undefined in remark-mdx 3.x; use the estree Program range instead.
    // estree range [start, end] covers the JS expression text (exclusive end, JS slice convention).
    const estree = attr.value?.data?.estree;
    if (estree?.range && estree.range.length === 2) {
      attrStart = estree.range[0] as number;
      attrEnd = estree.range[1] as number;
    }
  });

  if (attrStart === null || attrEnd === null) return { ok: false, reason: 'no_agent_tree' };

  let serialized: string;
  try {
    serialized = serializeTree(body.tree as AgentTreeNodeLike[]);
  } catch (err) {
    return {
      ok: false,
      reason: 'invalid',
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  const next = source.slice(0, attrStart) + serialized + source.slice(attrEnd);

  const tmp = join(dirname(absPath), `.agent-tree.${Date.now()}.tmp`);
  try {
    writeFileSync(tmp, next, 'utf8');
    renameSync(tmp, absPath);
    return { ok: true };
  } catch (err) {
    // Clean up tmp on failure — best-effort, ignore secondary errors.
    try {
      if (existsSync(tmp)) renameSync(tmp, `${tmp}.dead`);
    } catch {
      /* ignore cleanup error */
    }
    return { ok: false, reason: 'error', detail: String(err) };
  }
}
