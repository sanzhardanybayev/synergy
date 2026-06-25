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

type Result =
  | { ok: true }
  | { ok: false; reason: 'not_found' | 'no_agent_tree' | 'error'; detail?: string };

function serializeNode(n: AgentTreeNodeLike): string {
  const parts: string[] = [`name: '${n.name}'`, `type: '${n.type}'`];
  if (n.teamName !== undefined) parts.push(`teamName: '${n.teamName}'`);
  if (n.responsibility !== undefined)
    parts.push(`responsibility: '${n.responsibility.replace(/'/g, "\\'")}'`);
  if (n.model !== undefined) parts.push(`model: '${n.model}'`);
  if (n.effort !== undefined) parts.push(`effort: '${n.effort}'`);
  if (n.count !== undefined) parts.push(`count: ${n.count}`);
  if (n.subAgents?.length) parts.push(`subAgents: ${serializeTree(n.subAgents)}`);
  return `{ ${parts.join(', ')} }`;
}

export function serializeTree(nodes: AgentTreeNodeLike[]): string {
  return `[${nodes.map(serializeNode).join(', ')}]`;
}

export async function handleAgentTreePut(
  sessionsDir: string,
  body: { file: string; tree: AgentTreeNodeLike[] },
): Promise<Result> {
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

  visit(ast, 'mdxJsxFlowElement', (node: any) => {
    if (node.name !== 'AgentTree' || attrStart !== null) return;
    const attr = (node.attributes ?? []).find(
      (a: any) => a.type === 'mdxJsxAttribute' && a.name === 'nodes',
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

  const next = source.slice(0, attrStart) + serializeTree(body.tree) + source.slice(attrEnd);

  try {
    const tmp = join(dirname(absPath), `.agent-tree.${Date.now()}.tmp`);
    writeFileSync(tmp, next, 'utf8');
    renameSync(tmp, absPath);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: 'error', detail: String(err) };
  }
}
