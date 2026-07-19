import { sessions } from 'virtual:synergy/sessions';
import { Navigate, Route, Routes } from 'react-router-dom';
import { SessionShell } from './SessionShell.js';
import { ArchitecturePage } from './pages/ArchitecturePage.js';
import { ImplementationPage } from './pages/ImplementationPage.js';
import { OverviewPage } from './pages/OverviewPage.js';
import { PhasePage } from './pages/PhasePage.js';
import { ReviewRoute } from './review/ReviewRoute.js';

export function App() {
  const latest = sessions[0];
  return (
    <Routes>
      <Route path="/r/:workspaceId/:revisionId" element={<ReviewRoute />} />
      <Route
        path="/"
        element={latest ? <Navigate to={`/s/${latest.name}/overview`} replace /> : <EmptyState />}
      />
      <Route path="/s/:name" element={<SessionShell />}>
        <Route index element={<Navigate to="overview" replace />} />
        <Route path="overview" element={<OverviewPage />} />
        <Route path="architecture" element={<ArchitecturePage />} />
        <Route path="implementation" element={<ImplementationPage />} />
        <Route path="phases/:phaseSlug" element={<PhasePage />} />
        <Route path="*" element={<NotFound />} />
      </Route>
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}

function EmptyState() {
  return (
    <div className="empty">
      <h2>No sessions yet</h2>
      <p>
        Use the <code>synergy:create-spec</code> Claude Code skill to scaffold one, or run{' '}
        <code>synergy init</code> in your project root.
      </p>
    </div>
  );
}

function NotFound() {
  return (
    <div className="empty">
      <h2>Not found</h2>
    </div>
  );
}
