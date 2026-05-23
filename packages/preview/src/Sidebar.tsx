import { useEffect, useMemo, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import type { PhaseMeta, SessionMeta } from 'virtual:synergy/sessions';

export type OrchestratorTarget = 'root' | { phaseSlug: string };

interface Props {
  sessions: readonly SessionMeta[];
  currentSessionName: string;
  onOpenOrchestrator: (target: OrchestratorTarget) => void;
}

interface SpecRow {
  to: string;
  label: string;
}

const SPEC_ROW_DEFS: { basename: string; label: string; path: string }[] = [
  { basename: '00-overview.mdx', label: 'Overview', path: 'overview' },
  { basename: '01-architecture.mdx', label: 'Architecture', path: 'architecture' },
  { basename: '02-implementation.mdx', label: 'Implementation', path: 'implementation' },
];

export function Sidebar({ sessions, currentSessionName, onOpenOrchestrator }: Props) {
  const session = useMemo(
    () => sessions.find((s) => s.name === currentSessionName) ?? null,
    [sessions, currentSessionName],
  );
  const location = useLocation();

  // Phases auto-expand when on /implementation or any /phases/* route.
  const routeImpliesPhases =
    /\/implementation\b/.test(location.pathname) ||
    /\/phases\//.test(location.pathname);
  const [phasesExpanded, setPhasesExpanded] = useState(routeImpliesPhases);
  useEffect(() => {
    if (routeImpliesPhases) setPhasesExpanded(true);
  }, [routeImpliesPhases]);

  const [sessionsOpen, setSessionsOpen] = useState(false);

  if (!session) {
    return (
      <aside className="sidebar">
        <Brand />
        <p className="sidebar__hint">No session selected.</p>
      </aside>
    );
  }

  const sortedSessions = [...sessions].sort((a, b) => b.lastModified - a.lastModified);
  const hasImplementation = session.specs.includes('02-implementation.mdx');
  const showPhasesGroup = hasImplementation && session.phases.length > 0;
  const visibleSpecRows = buildSpecRows(session, currentSessionName);

  return (
    <aside className="sidebar">
      <Brand />

      <div className="sidebar__section">
        <button
          type="button"
          className="sidebar__sessions-toggle"
          aria-expanded={sessionsOpen}
          onClick={() => setSessionsOpen((s) => !s)}
        >
          <span className="sidebar__section-label">Session</span>
          <span className="sidebar__current">{currentSessionName}</span>
          <span className="sidebar__chevron" aria-hidden="true">
            {sessionsOpen ? '▴' : '▾'}
          </span>
        </button>
        {sessionsOpen ? (
          <ul className="sidebar__sessions" aria-label="Sessions">
            {sortedSessions.map((s) => (
              <li key={s.name}>
                <NavLink
                  to={`/s/${s.name}/overview`}
                  className={({ isActive }) =>
                    isActive || s.name === currentSessionName
                      ? 'sidebar__session sidebar__session--active'
                      : 'sidebar__session'
                  }
                  onClick={() => setSessionsOpen(false)}
                >
                  {s.name}
                </NavLink>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      <div className="sidebar__section">
        <h3 className="sidebar__section-label">Spec</h3>
        <ul className="sidebar__rows">
          {visibleSpecRows.map((row) => {
            const isImplementation = row.label === 'Implementation';
            return (
              <li key={row.to}>
                <div className="sidebar__row-line">
                  <NavLink
                    to={row.to}
                    end
                    className={({ isActive }) =>
                      isActive ? 'sidebar__row sidebar__row--active' : 'sidebar__row'
                    }
                  >
                    {row.label}
                  </NavLink>
                  {isImplementation && showPhasesGroup ? (
                    <button
                      type="button"
                      className="sidebar__chevron-btn"
                      aria-label={phasesExpanded ? 'Collapse phases' : 'Expand phases'}
                      aria-expanded={phasesExpanded}
                      onClick={() => setPhasesExpanded((p) => !p)}
                    >
                      {phasesExpanded ? '▾' : '▸'}
                    </button>
                  ) : null}
                </div>

                {isImplementation && showPhasesGroup && phasesExpanded ? (
                  <ul className="sidebar__phases" aria-label="Phases">
                    {session.phases.map((phase) => (
                      <li key={phase.slug}>
                        <NavLink
                          to={`/s/${currentSessionName}/phases/${phase.slug}`}
                          className={({ isActive }) =>
                            isActive
                              ? 'sidebar__phase sidebar__phase--active'
                              : 'sidebar__phase'
                          }
                          title={phaseTooltip(phase)}
                        >
                          {phaseLabel(phase)}
                        </NavLink>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            );
          })}
        </ul>
      </div>

      {session.hasOrchestrator ? (
        <div className="sidebar__section sidebar__section--bottom">
          <button
            type="button"
            className="sidebar__orchestrator"
            onClick={() => onOpenOrchestrator('root')}
          >
            <span aria-hidden="true">📎</span>
            <span>Orchestrator (root)</span>
          </button>
        </div>
      ) : null}
    </aside>
  );
}

function Brand() {
  return (
    <div className="sidebar__brand">
      <span className="sidebar__logo" aria-hidden="true">
        ⌬
      </span>
      <span className="sidebar__title">Synergy</span>
    </div>
  );
}

function buildSpecRows(session: SessionMeta, sessionName: string): SpecRow[] {
  return SPEC_ROW_DEFS.filter((def) => session.specs.includes(def.basename)).map(
    (def) => ({ to: `/s/${sessionName}/${def.path}`, label: def.label }),
  );
}

function phaseLabel(phase: PhaseMeta): string {
  return `Phase ${phase.order} — ${phase.title}`;
}

function phaseTooltip(phase: PhaseMeta): string {
  return `phases/${phase.folder}`;
}
