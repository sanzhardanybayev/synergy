import type { ReactNode } from 'react';
import type { ActorRole } from '../types.js';
import { UserIcon } from './icons.js';

export interface ReviewerProps {
  name: string;
  role: ActorRole;
  /** Which areas they sign off on. */
  scope: string;
  handle?: string;
  children?: ReactNode;
}

export function Reviewer({ name, role, scope, handle, children }: ReviewerProps) {
  return (
    <div className="sk-reviewer">
      <span className="sk-reviewer__icon" aria-hidden>
        <UserIcon size={18} />
      </span>
      <div className="sk-reviewer__body">
        <div className="sk-reviewer__head">
          <strong className="sk-reviewer__name">{name}</strong>
          <span className="sk-reviewer__role">{role}</span>
          {handle ? <span className="sk-reviewer__handle">@{handle}</span> : null}
        </div>
        <div className="sk-reviewer__scope">Reviews: {scope}</div>
        {children}
      </div>
    </div>
  );
}
