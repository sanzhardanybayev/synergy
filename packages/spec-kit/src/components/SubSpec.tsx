import type { ReactNode } from 'react';
import type { StatusValue } from '../types.js';
import { Status } from './Status.js';

export interface SubSpecProps {
  /** Sibling spec slug, e.g. "01-architecture". */
  slug: string;
  title: string;
  status?: StatusValue;
  /** Short one-line summary. */
  summary?: string;
  children?: ReactNode;
}

export function SubSpec({ slug, title, status, summary, children }: SubSpecProps) {
  return (
    <article className="sk-subspec" data-slug={slug}>
      <header className="sk-subspec__header">
        <a className="sk-subspec__link" href={`#${slug}`}>
          <span className="sk-subspec__slug">{slug}</span>
          <span className="sk-subspec__title">{title}</span>
        </a>
        {status ? <Status value={status} /> : null}
      </header>
      {summary ? <p className="sk-subspec__summary">{summary}</p> : null}
      {children}
    </article>
  );
}
