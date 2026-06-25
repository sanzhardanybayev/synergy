import clsx from 'clsx';
import type { ReactNode } from 'react';
import { type AgentTreeNode, flattenAgentTree } from '../agent-tree.js';
import type { AgentEffort, AgentModel } from '../types.js';

const MODELS: AgentModel[] = ['opus', 'sonnet', 'haiku'];
const EFFORTS: AgentEffort[] = ['low', 'medium', 'high', 'max'];

const typeLabel: Record<AgentTreeNode['type'], string> = {
  orchestrator: 'Orchestrator',
  'sub-agent': 'Sub-agent',
  'agent-team': 'Team',
};

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
  const flat = flattenAgentTree(nodes);
  return (
    <div className={clsx('sk-agent-tree', dirty && 'sk-agent-tree--dirty')}>
      {context ? <p className="sk-agent-tree__context">{context}</p> : null}
      {dirty ? <span className="sk-agent-tree__pending" aria-label="unsaved changes" /> : null}
      <ul className="sk-agent-tree__list">
        {flat.map(({ node, depth, resolvedEffort, resolvedModel }) => {
          const label = node.type === 'agent-team' ? (node.teamName ?? node.name) : node.name;
          const ownEffort = node.effort;
          return (
            <li
              key={node.name}
              data-agent-name={node.name}
              className="sk-agent-tree__row"
              style={{ paddingLeft: `${depth * 1.25}rem` }}
            >
              <span className="sk-agent-tree__name">{label}</span>
              {node.type === 'agent-team' && node.teamName ? (
                <span className="sk-agent-tree__agentname">{node.name}</span>
              ) : null}
              <span className={clsx('sk-agent-tree__type', `sk-agent-tree__type--${node.type}`)}>
                {typeLabel[node.type]}
              </span>

              {editable ? (
                <select
                  data-field="model"
                  className="sk-agent-tree__select"
                  value={resolvedModel ?? ''}
                  onChange={(e) => onModelChange?.(node.name, e.target.value as AgentModel)}
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

              {editable ? (
                <select
                  data-field="effort"
                  data-inherited={ownEffort === undefined ? 'true' : 'false'}
                  className="sk-agent-tree__select"
                  value={ownEffort ?? ''}
                  onChange={(e) =>
                    onEffortChange?.(node.name, e.target.value === '' ? null : (e.target.value as AgentEffort))
                  }
                >
                  <option value="">
                    inherit{resolvedEffort ? ` (${resolvedEffort})` : ''}
                  </option>
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
      {children}
    </div>
  );
}
