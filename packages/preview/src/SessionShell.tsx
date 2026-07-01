import { type SessionMeta, loaders, sessions } from 'virtual:synergy/sessions';
import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { Outlet, useNavigate, useParams } from 'react-router-dom';
import { ActiveSessionPinger } from './ActiveSessionPinger.js';
import { AgentTreeControlsProvider } from './AgentTreeControls.js';
import { CommentsPanel } from './CommentsPanel.js';
import { EditBufferProvider, useEditBuffer } from './EditBuffer.js';
import { OrchestratorDrawer } from './OrchestratorDrawer.js';
import { ProgressDrawer } from './ProgressDrawer.js';
import { ProgressProvider, useProgressData } from './ProgressProvider.js';
import { type OrchestratorTarget, Sidebar } from './Sidebar.js';
import { UnloadGuard } from './UnloadGuard.js';
import type { Comment } from './api.js';

interface SessionContextValue {
  session: SessionMeta;
  openOrchestrator: (target: OrchestratorTarget) => void;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used inside <SessionShell>');
  return ctx;
}

interface DrawerState {
  title: string;
  path: string;
  loader: () => Promise<{ default: string }>;
}

export function SessionShell() {
  const { name } = useParams<{ name: string }>();
  const session = sessions.find((s) => s.name === name) ?? null;

  if (!name || !session) {
    return (
      <div className="layout">
        <Sidebar
          sessions={sessions}
          currentSessionName={name ?? ''}
          onOpenOrchestrator={() => undefined}
        />
        <main className="layout__main">
          <div className="empty">
            <h2>Unknown session</h2>
            <p>
              No session named <code>{name ?? '(none)'}</code> was found in this project.
            </p>
          </div>
        </main>
      </div>
    );
  }

  return <ResolvedSessionShell session={session} />;
}

function ResolvedSessionShell({ session }: { session: SessionMeta }) {
  const [drawer, setDrawer] = useState<DrawerState | null>(null);

  const openOrchestrator = useCallback(
    (target: OrchestratorTarget) => {
      const sessionLoaders = loaders[session.name];
      if (!sessionLoaders) return;
      if (target === 'root') {
        if (!sessionLoaders.orchestrator || !session.paths.orchestrator) return;
        setDrawer({
          title: `Orchestrator — ${session.name}`,
          path: session.paths.orchestrator,
          loader: sessionLoaders.orchestrator,
        });
        return;
      }
      const { phaseSlug } = target;
      const phaseLoader = sessionLoaders.phaseOrchestrator[phaseSlug];
      const phasePath = session.paths.phaseOrchestrator[phaseSlug];
      const phase = session.phases.find((p) => p.slug === phaseSlug);
      if (phaseLoader && phasePath && phase) {
        setDrawer({
          title: `Orchestrator — Phase ${phase.order} — ${phase.title}`,
          path: phasePath,
          loader: phaseLoader,
        });
        return;
      }
      // Fallback to root orchestrator if the phase has none.
      if (sessionLoaders.orchestrator && session.paths.orchestrator) {
        setDrawer({
          title: `Orchestrator — ${session.name}`,
          path: session.paths.orchestrator,
          loader: sessionLoaders.orchestrator,
        });
      }
    },
    [session],
  );

  const closeDrawer = useCallback(() => setDrawer(null), []);
  const ctxValue = useMemo<SessionContextValue>(
    () => ({ session, openOrchestrator }),
    [session, openOrchestrator],
  );

  return (
    <EditBufferProvider>
      <SessionContext.Provider value={ctxValue}>
        {/* SessionInner can call useEditBuffer() since it's inside the provider. */}
        <SessionInner
          session={session}
          drawer={drawer}
          closeDrawer={closeDrawer}
          openOrchestrator={openOrchestrator}
        />
      </SessionContext.Provider>
    </EditBufferProvider>
  );
}

// ---------------------------------------------------------------------------
// SessionInner — lives inside EditBufferProvider, can use useEditBuffer().
// ---------------------------------------------------------------------------

interface SessionInnerProps {
  session: SessionMeta;
  drawer: DrawerState | null;
  closeDrawer: () => void;
  openOrchestrator: (target: OrchestratorTarget) => void;
}

function SessionInner({ session, drawer, closeDrawer, openOrchestrator }: SessionInnerProps) {
  const buffer = useEditBuffer();
  const navigate = useNavigate();
  const [commentsPanelOpen, setCommentsPanelOpen] = useState(false);
  const [progressOpen, setProgressOpen] = useState(false);

  const handleScrollToComment = useCallback(
    (comment: Comment) => {
      const routeSegment = commentFileToRouteSegment(session, comment.file);
      navigate(`/s/${session.name}/${routeSegment}`);
      buffer.focusComment(comment.id);
    },
    [session, navigate, buffer],
  );

  return (
    <>
      <UnloadGuard />
      <ActiveSessionPinger session={session.name} />

      <ProgressProvider session={session.name}>
        <div className="layout">
          <Sidebar
            sessions={sessions}
            currentSessionName={session.name}
            onOpenOrchestrator={openOrchestrator}
          />
          <main className="layout__main">
            <AgentTreeControlsProvider>
              <Outlet />
            </AgentTreeControlsProvider>
          </main>
          <OrchestratorDrawer
            open={drawer !== null}
            title={drawer?.title ?? ''}
            path={drawer?.path ?? ''}
            loader={drawer?.loader ?? (async () => ({ default: '' }))}
            onClose={closeDrawer}
          />
          <ProgressDrawerHost open={progressOpen} onClose={() => setProgressOpen(false)} />
        </div>

        <button
          type="button"
          className="progress-toggle"
          onClick={() => setProgressOpen((v) => !v)}
          aria-expanded={progressOpen}
          aria-label={progressOpen ? 'Close progress' : 'Open progress'}
        >
          {progressOpen ? '✕' : '📊'}
        </button>
      </ProgressProvider>

      {/* Fixed-position comments panel — does not restructure .layout grid */}
      <div
        className={`comments-panel-host${commentsPanelOpen ? ' comments-panel-host--open' : ''}`}
        aria-label="Comments panel"
      >
        <button
          type="button"
          className="comments-panel-host__toggle"
          onClick={() => setCommentsPanelOpen((v) => !v)}
          aria-expanded={commentsPanelOpen}
          aria-label={commentsPanelOpen ? 'Close comments panel' : 'Open comments panel'}
        >
          {commentsPanelOpen ? '✕' : '\u{1F4AC}'}
        </button>

        {commentsPanelOpen && (
          <CommentsPanel
            session={session.name}
            refreshKey={buffer.commentRefreshKey}
            onCountChange={(n) => buffer.setOpenCommentCount(n)}
            onScrollToAnchor={handleScrollToComment}
          />
        )}
      </div>
    </>
  );
}

function ProgressDrawerHost({ open, onClose }: { open: boolean; onClose: () => void }) {
  const data = useProgressData();
  return <ProgressDrawer open={open} data={data} onClose={onClose} />;
}

/** Map a session-relative feedback file path to an app route segment. */
function commentFileToRouteSegment(session: SessionMeta, file: string): string {
  if (file === '00-overview.mdx') return 'overview';
  if (file === '01-architecture.mdx') return 'architecture';
  if (file === '02-implementation.mdx') return 'implementation';

  const match = file.match(/^phases\/([^/]+)\/spec\.mdx$/);
  if (match) {
    const folder = match[1]!;
    const phase = session.phases.find((p) => p.folder === folder);
    if (phase) return `phases/${phase.slug}`;
  }

  return 'overview';
}
