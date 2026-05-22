import clsx from 'clsx';
import type { StatusValue } from '../types.js';

export interface StatusProps {
  value: StatusValue;
  /** Optional short note shown next to the badge. */
  note?: string;
}

const labelFor: Record<StatusValue, string> = {
  draft: 'Draft',
  proposed: 'Proposed',
  'in-progress': 'In progress',
  blocked: 'Blocked',
  done: 'Done',
  shipped: 'Shipped',
};

export function Status({ value, note }: StatusProps) {
  return (
    <span className={clsx('sk-status', `sk-status--${value}`)} data-status={value}>
      <span className="sk-status__dot" aria-hidden />
      <span className="sk-status__label">{labelFor[value]}</span>
      {note ? <span className="sk-status__note">— {note}</span> : null}
    </span>
  );
}
