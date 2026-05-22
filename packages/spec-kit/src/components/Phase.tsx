import type { ReactNode } from 'react';
import clsx from 'clsx';
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
  children?: ReactNode;
}

export function Phase({ number, title, status, summary, estimate, children }: PhaseProps) {
  return (
    <section className={clsx('sk-phase')} data-phase={number}>
      <header className="sk-phase__header">
        <span className="sk-phase__number">Phase {number}</span>
        <h3 className="sk-phase__title">{title}</h3>
        <div className="sk-phase__meta">
          {status ? <Status value={status} /> : null}
          {estimate ? <span className="sk-phase__estimate">⏱ {estimate}</span> : null}
        </div>
      </header>
      {summary ? <p className="sk-phase__summary">{summary}</p> : null}
      {children ? <div className="sk-phase__body">{children}</div> : null}
    </section>
  );
}
