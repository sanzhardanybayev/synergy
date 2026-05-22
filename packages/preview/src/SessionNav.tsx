import { NavLink } from 'react-router-dom';
import { sessions } from 'virtual:synergy/sessions';

function formatDate(ms: number): string {
  if (!ms) return '';
  return new Date(ms).toLocaleString();
}

export function SessionNav() {
  return (
    <nav className="nav">
      <div className="nav__brand">
        <span className="nav__logo">⌬</span>
        <span className="nav__title">Synergy</span>
      </div>
      <div className="nav__sessions" role="tablist">
        {sessions.length === 0 ? (
          <span className="nav__hint">No sessions yet</span>
        ) : (
          sessions.map((s) => (
            <NavLink
              key={s.name}
              to={`/s/${s.name}`}
              className={({ isActive }) =>
                isActive ? 'nav__session nav__session--active' : 'nav__session'
              }
              title={`Last modified: ${formatDate(s.lastModified)}`}
            >
              <span className="nav__session-name">{s.name}</span>
              <span className="nav__session-meta">{s.specs.length} spec(s)</span>
            </NavLink>
          ))
        )}
      </div>
    </nav>
  );
}
