import { lazy, Suspense, useMemo, useState } from 'react';
import { loaders, type SessionMeta } from 'virtual:synergy/sessions';
import { OrchestratorPanel } from './OrchestratorPanel.js';

interface Props {
  session: SessionMeta;
}

interface SpecChunk {
  spec: string;
  Component: ReturnType<typeof lazy>;
}

function buildChunks(sessionName: string, specs: string[]): SpecChunk[] {
  const sessionLoaders = loaders[sessionName] ?? {};
  return specs.map((spec) => {
    const loader = sessionLoaders[spec];
    if (!loader) {
      const Missing = () => <div className="spec-missing">Loader missing for {spec}</div>;
      return { spec, Component: lazy(async () => ({ default: Missing })) };
    }
    return {
      spec,
      Component: lazy(async () => {
        const mod = (await loader()) as { default: React.ComponentType };
        return { default: mod.default };
      }),
    };
  });
}

export function SessionView({ session }: Props) {
  const chunks = useMemo(() => buildChunks(session.name, session.specs), [session.name, session.specs]);
  const [showOrchestrator, setShowOrchestrator] = useState(false);

  return (
    <article className="session">
      <header className="session__header">
        <h1 className="session__title">{session.name}</h1>
        <div className="session__actions">
          {session.hasOrchestrator ? (
            <button
              type="button"
              className="session__action"
              onClick={() => setShowOrchestrator((s) => !s)}
            >
              {showOrchestrator ? 'Hide' : 'Show'} orchestrator
            </button>
          ) : null}
        </div>
      </header>

      {showOrchestrator && session.hasOrchestrator ? (
        <OrchestratorPanel sessionName={session.name} />
      ) : null}

      <div className="session__toc">
        <strong>Contents</strong>
        <ol>
          {session.specs.map((spec) => {
            const slug = spec.replace(/\.mdx?$/i, '');
            return (
              <li key={spec}>
                <a href={`#${slug}`}>{slug}</a>
              </li>
            );
          })}
        </ol>
      </div>

      <div className="session__body">
        {chunks.map(({ spec, Component }) => {
          const slug = spec.replace(/\.mdx?$/i, '');
          return (
            <section key={spec} id={slug} className="spec">
              <header className="spec__header">
                <code className="spec__slug">{spec}</code>
              </header>
              <div className="spec__body">
                <Suspense fallback={<div className="spec__loading">Loading {spec}…</div>}>
                  <Component />
                </Suspense>
              </div>
            </section>
          );
        })}
      </div>
    </article>
  );
}
