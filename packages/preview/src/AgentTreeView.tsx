import { AgentTree, type AgentTreeNode } from '@synergy/spec-kit';
import { useMemo } from 'react';
import { useEditBuffer } from './EditBuffer.js';

function mapNodes(
  nodes: AgentTreeNode[],
  name: string,
  apply: (n: AgentTreeNode) => AgentTreeNode,
): AgentTreeNode[] {
  return nodes.map((n) => {
    const next = n.name === name ? apply(n) : n;
    return next.subAgents ? { ...next, subAgents: mapNodes(next.subAgents, name, apply) } : next;
  });
}

export interface AgentTreeViewProps {
  nodes: AgentTreeNode[];
  /** sessionsDir-relative path of the MDX file holding this AgentTree. */
  file: string;
}

export function AgentTreeView({ nodes, file }: AgentTreeViewProps) {
  const buffer = useEditBuffer();
  const key = `agent-tree:${file}`;
  const entry = buffer.entries.get(key);
  const currentTree = (entry?.kind === 'agent-tree' ? entry.currentTree : nodes) as AgentTreeNode[];
  const dirty = entry?.kind === 'agent-tree';

  const setTree = useMemo(
    () => (next: AgentTreeNode[]) =>
      buffer.setDirtyAgentTree(key, {
        kind: 'agent-tree',
        file,
        originalTree: nodes,
        currentTree: next,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [buffer, key, file, nodes],
  );

  return (
    <div className="sk-agent-tree-view">
      <AgentTree
        nodes={currentTree}
        editable
        dirty={dirty}
        onModelChange={(name, model) =>
          setTree(mapNodes(currentTree, name, (n) => ({ ...n, model })))
        }
        onEffortChange={(name, effort) =>
          setTree(
            mapNodes(currentTree, name, (n) => {
              const next = { ...n };
              if (effort === null) {
                delete next.effort;
              } else {
                next.effort = effort;
              }
              return next;
            }),
          )
        }
      />
      {dirty ? (
        <div className="sk-agent-tree-view__actions">
          <button type="button" onClick={() => buffer.applyOne(key)}>
            Save
          </button>
          <button type="button" onClick={() => buffer.discard(key)}>
            Discard
          </button>
        </div>
      ) : null}
    </div>
  );
}
