import { loaders } from 'virtual:synergy/sessions';
import { type ComponentType, Suspense, lazy, useMemo } from 'react';
import { useParams } from 'react-router-dom';
import { PageHeader } from '../PageHeader.js';
import { useSession } from '../SessionShell.js';

export function PhasePage() {
  const { phaseSlug = '' } = useParams<{ phaseSlug: string }>();
  const { session } = useSession();

  const phase = session.phases.find((p) => p.slug === phaseSlug) ?? null;
  const sessionLoaders = loaders[session.name];
  const loader = phase ? sessionLoaders?.phaseSpec[phase.slug] : undefined;

  const Lazy = useMemo<ComponentType | null>(() => {
    if (!loader) return null;
    return lazy(async () => {
      const mod = await loader();
      return { default: mod.default };
    });
  }, [loader]);

  if (!phase || !Lazy) {
    return (
      <div className="page page--missing">
        <PageHeader
          title={`Phase ${phaseSlug}`}
          relativePath={`phases/${phaseSlug}/spec.mdx`}
          sessionPath={session.paths.session}
          pagePath={`${session.paths.session}/phases/${phaseSlug}/spec.mdx`}
          orchestratorPath={session.paths.orchestrator}
        />
        <div className="empty">
          <h2>Not found</h2>
          <p>
            No phase with slug <code>{phaseSlug}</code> exists in this session.
          </p>
        </div>
      </div>
    );
  }

  const relativePath = `phases/${phase.folder}/spec.mdx`;
  const pagePath = session.paths.phaseSpec[phase.slug]!;
  // Phase orchestrator path: phase-specific if it exists, else root orchestrator.
  const orchestratorPath =
    session.paths.phaseOrchestrator[phase.slug] ?? session.paths.orchestrator;

  return (
    <article className="page">
      <PageHeader
        title={`Phase ${phase.order} — ${phase.title}`}
        relativePath={relativePath}
        sessionPath={session.paths.session}
        pagePath={pagePath}
        orchestratorPath={orchestratorPath}
      />
      <div className="page__body mdx-body">
        <Suspense fallback={<div className="page__loading">Loading {relativePath}…</div>}>
          <Lazy />
        </Suspense>
      </div>
    </article>
  );
}
