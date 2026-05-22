import type { ReactNode } from 'react';
import clsx from 'clsx';
import type { AgentType } from '../types.js';

export interface AgentAllocationEntry {
  name: string;
  type: AgentType;
  /** What this agent owns. */
  responsibility: string;
  /** Optional: which phases they touch. */
  phases?: number[];
}

export interface AgentAllocationProps {
  /** Short context line above the table. */
  context?: string;
  entries: AgentAllocationEntry[];
  children?: ReactNode;
}

const typeLabel: Record<AgentType, string> = {
  'sub-agent': 'Sub-agent',
  'agent-team': 'Agent team',
  human: 'Human',
};

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
            </tr>
          ))}
        </tbody>
      </table>
      {children}
    </div>
  );
}
