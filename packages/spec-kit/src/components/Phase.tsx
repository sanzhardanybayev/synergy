import clsx from 'clsx';
import type { ReactNode } from 'react';
import { useExecutionState } from '../ExecutionState.js';
import type { StatusValue } from '../types.js';
import { Status } from './Status.js';

export interface PhaseProps {
  number: number;
  title: string;
  /** Stable slug used to key execution state, e.g. "storage". */
  id?: string;
  /** Authored status badge; overridden by live execution state when present. */
  status?: StatusValue;
  summary?: string;
  estimate?: string;
  editable?: boolean;
  statusDirty?: boolean;
  onStatusChange?: (next: StatusValue) => void;
  children?: ReactNode;
}

export function Phase({
  number,
  title,
  id,
  status,
  summary,
  estimate,
  editable = false,
  statusDirty = false,
  onStatusChange,
  children,
}: PhaseProps) {
  const exec = useExecutionState();
  const live = id ? exec.phases[id] : undefined;
  const effectiveStatus = live?.status ?? status;

  return (
    <section className={clsx('sk-phase')} data-phase={number} data-phase-id={id}>
      <header className="sk-phase__header">
        <span className="sk-phase__number">Phase {number}</span>
        <h3 className="sk-phase__title">{title}</h3>
        <div className="sk-phase__meta">
          {effectiveStatus ? (
            <Status
              value={effectiveStatus}
              editable={editable}
              dirty={statusDirty}
              onChange={onStatusChange}
            />
          ) : null}
          {estimate ? <span className="sk-phase__estimate">⏱ {estimate}</span> : null}
        </div>
      </header>
      {summary ? <p className="sk-phase__summary">{summary}</p> : null}
      {live?.latestFinding ? (
        <p className="sk-phase__finding" data-testid="phase-finding">
          {live.latestFinding}
        </p>
      ) : null}
      {children ? <div className="sk-phase__body">{children}</div> : null}
    </section>
  );
}
