import clsx from 'clsx';
import type { ReactNode } from 'react';
import { useExecutionState } from '../ExecutionState.js';
import type { StatusValue } from '../types.js';
import { Status } from './Status.js';

export interface TimelineMilestone {
  label: string;
  /** ISO date or human string. */
  when?: string;
  status?: StatusValue;
  description?: string;
}

export interface TimelineProps {
  /** Legacy static milestones. Omit for the phase-driven live form. */
  milestones?: TimelineMilestone[];
  /** Optional caption above the timeline. */
  caption?: string;
  children?: ReactNode;
}

export function Timeline({ milestones, caption, children }: TimelineProps) {
  const { roster = [], derived } = useExecutionState();

  // Phase-driven form: no authored milestones -> render the live roster.
  if (!milestones) {
    if (roster.length === 0) return null;
    const percent = derived?.percent ?? 0;
    return (
      <figure className="sk-timeline sk-timeline--phases">
        {caption ? <figcaption className="sk-timeline__caption">{caption}</figcaption> : null}
        <div className="sk-timeline__bar" aria-hidden="true">
          <div
            className="sk-timeline__fill"
            data-testid="timeline-bar-fill"
            style={{ width: `${percent}%` }}
          />
        </div>
        <p className="sk-timeline__rollup">
          {derived?.done ?? 0} / {derived?.total ?? roster.length} phases ({percent}%)
        </p>
        <ol className="sk-timeline__steps">
          {roster.map((step) => (
            <li
              key={step.slug}
              className={clsx('sk-timeline__step', `sk-timeline__step--${step.status}`)}
            >
              <span className="sk-timeline__step-num">{step.number}</span>
              <span className="sk-timeline__step-title">{step.title}</span>
              <Status value={step.status} />
            </li>
          ))}
        </ol>
        {children}
      </figure>
    );
  }

  // Legacy static milestone form.
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
              {m.description ? <p className="sk-timeline__description">{m.description}</p> : null}
            </div>
          </li>
        ))}
      </ol>
      {children}
    </figure>
  );
}
