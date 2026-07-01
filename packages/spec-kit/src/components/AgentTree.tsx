import clsx from 'clsx';
import { type ReactNode, createContext, useContext } from 'react';
import { type AgentTreeNode, flattenAgentTree } from '../agent-tree.js';
import type { AgentEffort, AgentModel } from '../types.js';

const MODELS: AgentModel[] = ['opus', 'sonnet', 'haiku'];
const EFFORTS: AgentEffort[] = ['low', 'medium', 'high', 'max'];

const typeLabel: Record<AgentTreeNode['type'], string> = {
  orchestrator: 'Orchestrator',
  'sub-agent': 'Sub-agent',
  'agent-team': 'Team',
};

/**
 * Live edit controls a host (e.g. the Synergy preview) supplies so an AgentTree
 * authored in MDX becomes interactive — model/effort dropdowns + Save/Discard —
 * regardless of whether the MDX `import`ed `AgentTree` or received it via the
 * MDXProvider. This is the mechanism that makes editability immune to import
 * shadowing.
 */
export interface AgentTreeControls {
  /** The current (possibly dirty) tree to render in place of the authored nodes. */
  nodes: AgentTreeNode[];
  dirty: boolean;
  onModelChange: (name: string, model: AgentModel) => void;
  /** effort === null means "clear override, inherit from ancestor". */
  onEffortChange: (name: string, effort: AgentEffort | null) => void;
  onSave: () => void;
  onDiscard: () => void;
}

/**
 * A factory: given an AgentTree's authored nodes, returns live edit controls, or
 * `null` when editing is unavailable (e.g. no active file). The context default
 * is `null` → read-only, so a static/standalone render needs no provider. The
 * preview supplies a factory wired to its edit buffer.
 */
export const AgentTreeControlsContext = createContext<
  ((authored: AgentTreeNode[]) => AgentTreeControls | null) | null
>(null);

export interface AgentTreeProps {
  nodes: AgentTreeNode[];
  context?: string;
  editable?: boolean;
  dirty?: boolean;
  /** effort === null means "clear override, inherit from ancestor". */
  onEffortChange?: (name: string, effort: AgentEffort | null) => void;
  onModelChange?: (name: string, model: AgentModel) => void;
  children?: ReactNode;
}

export function AgentTree({
  nodes,
  context,
  editable = false,
  dirty = false,
  onEffortChange,
  onModelChange,
  children,
}: AgentTreeProps) {
  // Host-provided controls (preview) take precedence and make the tree editable
  // even when the component was imported directly by the MDX file. When no host
  // is present we fall back to the explicit props (static/standalone usage).
  const controlsFactory = useContext(AgentTreeControlsContext);
  const controls = controlsFactory ? controlsFactory(nodes) : null;

  const isEditable = controls ? true : editable;
  const isDirty = controls ? controls.dirty : dirty;
  const renderNodes = controls ? controls.nodes : nodes;
  const handleModel = controls ? controls.onModelChange : onModelChange;
  const handleEffort = controls ? controls.onEffortChange : onEffortChange;

  const flat = flattenAgentTree(renderNodes);
  return (
    <div className={clsx('sk-agent-tree', isDirty && 'sk-agent-tree--dirty')}>
      {context ? <p className="sk-agent-tree__context">{context}</p> : null}
      {isDirty ? <span className="sk-agent-tree__pending" aria-label="unsaved changes" /> : null}
      <ul className="sk-agent-tree__list">
        {flat.map(({ node, depth, resolvedEffort, resolvedModel }) => {
          const label = node.type === 'agent-team' ? (node.teamName ?? node.name) : node.name;
          const ownEffort = node.effort;
          return (
            <li
              key={node.name}
              data-agent-name={node.name}
              className="sk-agent-tree__row"
              style={{ paddingLeft: `${0.75 + depth * 1.25}rem` }}
            >
              <span className="sk-agent-tree__name">{label}</span>
              {node.type === 'agent-team' && node.teamName ? (
                <span className="sk-agent-tree__agentname">{node.name}</span>
              ) : null}
              <span className={clsx('sk-agent-tree__type', `sk-agent-tree__type--${node.type}`)}>
                {typeLabel[node.type]}
              </span>

              {isEditable ? (
                <select
                  data-field="model"
                  className="sk-agent-tree__select"
                  value={resolvedModel ?? ''}
                  onChange={(e) => handleModel?.(node.name, e.target.value as AgentModel)}
                >
                  <option value="" disabled>
                    model…
                  </option>
                  {MODELS.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="sk-agent-tree__model">{resolvedModel ?? '—'}</span>
              )}

              {node.count !== undefined && node.count > 1 ? (
                <span className="sk-agent-tree__count">×{node.count}</span>
              ) : null}

              {isEditable ? (
                <select
                  data-field="effort"
                  data-inherited={ownEffort === undefined ? 'true' : 'false'}
                  className="sk-agent-tree__select"
                  value={ownEffort ?? ''}
                  onChange={(e) =>
                    handleEffort?.(
                      node.name,
                      e.target.value === '' ? null : (e.target.value as AgentEffort),
                    )
                  }
                >
                  <option value="">inherit{resolvedEffort ? ` (${resolvedEffort})` : ''}</option>
                  {EFFORTS.map((ef) => (
                    <option key={ef} value={ef}>
                      {ef}
                    </option>
                  ))}
                </select>
              ) : (
                <span
                  className="sk-agent-tree__effort"
                  data-inherited={ownEffort === undefined ? 'true' : 'false'}
                >
                  {resolvedEffort ?? '—'}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {controls && isDirty ? (
        <div className="sk-agent-tree-view__actions">
          <button type="button" onClick={controls.onSave}>
            Save
          </button>
          <button type="button" onClick={controls.onDiscard}>
            Discard
          </button>
        </div>
      ) : null}
      {children}
    </div>
  );
}
