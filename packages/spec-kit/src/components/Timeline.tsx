import type { ReactNode } from 'react';
import clsx from 'clsx';
import type { StatusValue } from '../types.js';

export interface TimelineMilestone {
  label: string;
  /** ISO date or human string. */
  when?: string;
  status?: StatusValue;
  description?: string;
}

export interface TimelineProps {
  milestones: TimelineMilestone[];
  /** Optional caption above the timeline. */
  caption?: string;
  children?: ReactNode;
}

export function Timeline({ milestones, caption, children }: TimelineProps) {
  return (
    <figure className="sk-timeline">
      {caption ? <figcaption className="sk-timeline__caption">{caption}</figcaption> : null}
      <ol className="sk-timeline__list">
        {milestones.map((m, i) => (
          <li
            key={`${m.label}-${i}`}
            className={clsx('sk-timeline__item', m.status && `sk-timeline__item--${m.status}`)}
          >
            <span className="sk-timeline__marker" aria-hidden />
            <div className="sk-timeline__content">
              <div className="sk-timeline__head">
                <strong className="sk-timeline__label">{m.label}</strong>
                {m.when ? <span className="sk-timeline__when">{m.when}</span> : null}
              </div>
              {m.description ? (
                <p className="sk-timeline__description">{m.description}</p>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
      {children}
    </figure>
  );
}
