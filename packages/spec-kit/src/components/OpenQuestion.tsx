import type { ReactNode } from 'react';

export interface OpenQuestionProps {
  /** Short identifier, e.g. "Q1". Used for cross-refs. */
  id?: string;
  question: string;
  /** Who needs to answer. */
  owner?: string;
  /** When this needs to be resolved. */
  resolveBy?: string;
  /** Body — what's blocked, what's been considered. */
  children?: ReactNode;
}

export function OpenQuestion({ id, question, owner, resolveBy, children }: OpenQuestionProps) {
  return (
    <aside className="sk-question" data-question-id={id ?? ''}>
      <header className="sk-question__header">
        <span className="sk-question__icon" aria-hidden>❓</span>
        {id ? <span className="sk-question__id">{id}</span> : null}
        <span className="sk-question__text">{question}</span>
      </header>
      <div className="sk-question__meta">
        {owner ? <span className="sk-question__owner">Owner: {owner}</span> : null}
        {resolveBy ? <span className="sk-question__by">Needed by: {resolveBy}</span> : null}
      </div>
      {children ? <div className="sk-question__body">{children}</div> : null}
    </aside>
  );
}
