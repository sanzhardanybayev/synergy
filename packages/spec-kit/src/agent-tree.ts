import type { AgentEffort, AgentModel } from './types.js';

export interface AgentTreeNode {
  name: string;
  type: 'orchestrator' | 'sub-agent' | 'agent-team';
  /** Display name for team nodes. */
  teamName?: string;
  responsibility?: string;
  /** Per-node model. Does NOT inherit. */
  model?: AgentModel;
  /** Effort; inherited from the nearest ancestor when absent. */
  effort?: AgentEffort;
  count?: number;
  /** Child nodes. Recurses for tree traversal. */
  subAgents?: AgentTreeNode[];
}

export interface FlatAgentNode {
  node: AgentTreeNode;
  depth: number;
  parentName: string | null;
  resolvedEffort: AgentEffort | null;
  resolvedModel: AgentModel | null;
}

export function flattenAgentTree(nodes: AgentTreeNode[]): FlatAgentNode[] {
  const out: FlatAgentNode[] = [];
  const walk = (
    list: AgentTreeNode[],
    depth: number,
    parentName: string | null,
    inheritedEffort: AgentEffort | null,
  ) => {
    for (const node of list) {
      const resolvedEffort = node.effort ?? inheritedEffort;
      out.push({
        node,
        depth,
        parentName,
        resolvedEffort,
        resolvedModel: node.model ?? null,
      });
      if (node.subAgents?.length) {
        walk(node.subAgents, depth + 1, node.name, resolvedEffort);
      }
    }
  };
  walk(nodes, 0, null, null);
  return out;
}

export function resolveNodeEffort(name: string, nodes: AgentTreeNode[]): AgentEffort | null {
  const hit = flattenAgentTree(nodes).find((f) => f.node.name === name);
  return hit ? hit.resolvedEffort : null;
}

export function collectAgentNames(nodes: AgentTreeNode[]): string[] {
  return flattenAgentTree(nodes).map((f) => f.node.name);
}
