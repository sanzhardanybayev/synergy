import clsx from 'clsx';
import type { ReactNode } from 'react';
import type { StatusValue } from '../types.js';
import { Status } from './Status.js';

export interface PhaseProps {
  number: number;
  title: string;
  /** Optional status badge for this phase. */
  status?: StatusValue;
  /** Short summary shown under the heading. */
  summary?: string;
  /** Estimated effort: e.g. "1d", "half day". */
  estimate?: string;
  editable?: boolean;
  statusDirty?: boolean;
  onStatusChange?: (next: StatusValue) => void;
  children?: ReactNode;
}

export function Phase({
  number,
  title,
  status,
  summary,
  estimate,
  editable = false,
  statusDirty = false,
  onStatusChange,
  children,
}: PhaseProps) {
  return (
    <section className={clsx('sk-phase')} data-phase={number}>
      <header className="sk-phase__header">
        <span className="sk-phase__number">Phase {number}</span>
        <h3 className="sk-phase__title">{title}</h3>
        <div className="sk-phase__meta">
          {status ? (
            <Status
              value={status}
              editable={editable}
              dirty={statusDirty}
              onChange={onStatusChange}
            />
          ) : null}
          {estimate ? <span className="sk-phase__estimate">⏱ {estimate}</span> : null}
        </div>
      </header>
      {summary ? <p className="sk-phase__summary">{summary}</p> : null}
      {children ? <div className="sk-phase__body">{children}</div> : null}
    </section>
  );
}
