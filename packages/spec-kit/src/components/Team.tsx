import type { ReactNode } from 'react';
import type { ActorRole } from '../types.js';

export interface TeamMember {
  name: string;
  role: ActorRole;
  /** Optional handle, e.g. github username. */
  handle?: string;
}

export interface TeamProps {
  name: string;
  members: TeamMember[];
  /** What this team is responsible for. */
  mission?: string;
  children?: ReactNode;
}

export function Team({ name, members, mission, children }: TeamProps) {
  return (
    <section className="sk-team">
      <header className="sk-team__header">
        <h4 className="sk-team__name">{name}</h4>
        {mission ? <p className="sk-team__mission">{mission}</p> : null}
      </header>
      <ul className="sk-team__members">
        {members.map((m, i) => (
          <li key={`${m.name}-${i}`} className="sk-team__member">
            <span className="sk-team__member-name">{m.name}</span>
            <span className="sk-team__member-role">{m.role}</span>
            {m.handle ? <span className="sk-team__member-handle">@{m.handle}</span> : null}
          </li>
        ))}
      </ul>
      {children}
    </section>
  );
}
