import { Navigate, Route, Routes, useParams } from 'react-router-dom';
import { sessions } from 'virtual:synergy/sessions';
import { SessionNav } from './SessionNav.js';
import { SessionView } from './SessionView.js';

export function App() {
  const latest = sessions[0];
  return (
    <div className="app">
      <SessionNav />
      <main className="app__main">
        <Routes>
          <Route
            path="/"
            element={
              latest ? <Navigate to={`/s/${latest.name}`} replace /> : <EmptyState />
            }
          />
          <Route path="/s/:name" element={<SessionViewRoute />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </main>
    </div>
  );
}

function SessionViewRoute() {
  const { name } = useParams<{ name: string }>();
  if (!name) return <NotFound />;
  const session = sessions.find((s) => s.name === name);
  if (!session) {
    return (
      <div className="app__empty">
        <h2>Unknown session</h2>
        <p>
          No session named <code>{name}</code> was found in this project.
        </p>
      </div>
    );
  }
  return <SessionView session={session} />;
}

function EmptyState() {
  return (
    <div className="app__empty">
      <h2>No sessions yet</h2>
      <p>
        Create one with <code>synergy spec "My feature"</code>.
      </p>
    </div>
  );
}

function NotFound() {
  return (
    <div className="app__empty">
      <h2>Not found</h2>
    </div>
  );
}
