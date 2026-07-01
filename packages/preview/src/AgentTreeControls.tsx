/**
 * AgentTreeControlsProvider — supplies live edit controls to every AgentTree
 * rendered from MDX, via the spec-kit `AgentTreeControlsContext`.
 *
 * This is what makes the model/effort dropdowns + Save/Discard work regardless
 * of whether the MDX file `import`ed `AgentTree` directly (which shadows the
 * MDXProvider component map) or received it through the provider. State lives in
 * the shared EditBuffer, keyed by the active file.
 */

import type { AgentTreeControls, AgentTreeNode } from '@synergy/spec-kit';
import { AgentTreeControlsContext } from '@synergy/spec-kit';
import { type ReactNode, useCallback } from 'react';
import { useEditBuffer } from './EditBuffer.js';

/** Return a new tree with `apply` run on the node named `name` (recursively). */
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

export function AgentTreeControlsProvider({ children }: { children: ReactNode }) {
  const buffer = useEditBuffer();
  const { currentFile, entries, setDirtyAgentTree, applyOne, discard } = buffer;

  const factory = useCallback(
    (authored: AgentTreeNode[]): AgentTreeControls | null => {
      // No active file yet → not editable (read-only render).
      if (!currentFile) return null;
      const key = `agent-tree:${currentFile}`;
      const entry = entries.get(key);
      const nodes = entry?.kind === 'agent-tree' ? entry.currentTree : authored;
      const dirty = entry?.kind === 'agent-tree';
      const setTree = (next: AgentTreeNode[]) =>
        setDirtyAgentTree(key, {
          kind: 'agent-tree',
          file: currentFile,
          originalTree: authored,
          currentTree: next,
        });
      return {
        nodes,
        dirty,
        onModelChange: (name, model) => setTree(mapNodes(nodes, name, (n) => ({ ...n, model }))),
        onEffortChange: (name, effort) =>
          setTree(mapNodes(nodes, name, (n) => ({ ...n, effort: effort ?? undefined }))),
        onSave: () => applyOne(key),
        onDiscard: () => discard(key),
      };
    },
    [currentFile, entries, setDirtyAgentTree, applyOne, discard],
  );

  return (
    <AgentTreeControlsContext.Provider value={factory}>
      {children}
    </AgentTreeControlsContext.Provider>
  );
}
