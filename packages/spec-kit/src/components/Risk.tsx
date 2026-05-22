import type { ReactNode } from 'react';
import clsx from 'clsx';
import type { RiskCategory, Severity } from '../types.js';

export interface RiskProps {
  /** Short identifier, e.g. "R1". */
  id?: string;
  title: string;
  severity: Severity;
  category?: RiskCategory;
  /** What mitigates this. */
  mitigation?: string;
  children?: ReactNode;
}

export function Risk({ id, title, severity, category, mitigation, children }: RiskProps) {
  return (
    <aside className={clsx('sk-risk', `sk-risk--${severity}`)} data-risk-id={id ?? ''}>
      <header className="sk-risk__header">
        <span className={clsx('sk-risk__badge', `sk-risk__badge--${severity}`)}>
          {severity.toUpperCase()}
        </span>
        {id ? <span className="sk-risk__id">{id}</span> : null}
        <span className="sk-risk__title">{title}</span>
        {category ? <span className="sk-risk__category">{category}</span> : null}
      </header>
      {mitigation ? (
        <div className="sk-risk__mitigation">
          <strong>Mitigation:</strong> {mitigation}
        </div>
      ) : null}
      {children ? <div className="sk-risk__body">{children}</div> : null}
    </aside>
  );
}
