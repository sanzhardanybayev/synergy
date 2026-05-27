import clsx from 'clsx';
import type { ReactNode } from 'react';
import type { AgentEffort, AgentModel, AgentType } from '../types.js';

export interface AgentAllocationEntry {
  name: string;
  type: AgentType;
  responsibility: string;
  /** Phases this agent touches — slugs (preferred) or legacy numbers. */
  phases?: (number | string)[];
  /** Default model for fan-out, e.g. "opus". Overridable per run by the execute skill. */
  model?: AgentModel;
  /** Default thinking effort for fan-out. */
  effort?: AgentEffort;
  /** How many parallel instances to spawn. */
  count?: number;
}

export interface AgentAllocationProps {
  context?: string;
  entries: AgentAllocationEntry[];
  children?: ReactNode;
}

const typeLabel: Record<AgentType, string> = {
  'sub-agent': 'Sub-agent',
  'agent-team': 'Agent team',
  human: 'Human',
};

function fanout(e: AgentAllocationEntry): string {
  if (e.type === 'human') return '—';
  const parts: string[] = [];
  if (e.model) parts.push(e.model);
  if (e.effort) parts.push(e.effort);
  if (e.count && e.count > 1) parts.push(`×${e.count}`);
  return parts.length ? parts.join(' · ') : '—';
}

export function AgentAllocation({ context, entries, children }: AgentAllocationProps) {
  return (
    <div className="sk-allocation">
      {context ? <p className="sk-allocation__context">{context}</p> : null}
      <table className="sk-allocation__table">
        <thead>
          <tr>
            <th>Agent</th>
            <th>Type</th>
            <th>Responsibility</th>
            <th>Phases</th>
            <th>Fan-out</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e, i) => (
            <tr key={`${e.name}-${i}`}>
              <td>
                <strong>{e.name}</strong>
              </td>
              <td>
                <span className={clsx('sk-allocation__type', `sk-allocation__type--${e.type}`)}>
                  {typeLabel[e.type]}
                </span>
              </td>
              <td>{e.responsibility}</td>
              <td>{e.phases?.length ? e.phases.join(', ') : '—'}</td>
              <td className="sk-allocation__fanout">{fanout(e)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {children}
    </div>
  );
}
