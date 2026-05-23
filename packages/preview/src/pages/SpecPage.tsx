import { type ComponentType, type ReactNode, Suspense, lazy, useMemo } from 'react';
import { loaders } from 'virtual:synergy/sessions';
import { PageHeader } from '../PageHeader.js';
import { useSession } from '../SessionShell.js';

interface Props {
  basename: '00-overview.mdx' | '01-architecture.mdx' | '02-implementation.mdx';
  title: string;
  /** Optional secondary content (e.g., phase index callouts) below the MDX. */
  children?: ReactNode;
}

export function SpecPage({ basename, title }: Props) {
  const { session } = useSession();
  const hasFile = session.specs.includes(basename);
  const sessionLoaders = loaders[session.name];
  const loader = sessionLoaders?.spec[basename];

  const Lazy = useMemo<ComponentType | null>(() => {
    if (!loader) return null;
    return lazy(async () => {
      const mod = await loader();
      return { default: mod.default };
    });
  }, [loader]);

  if (!hasFile || !Lazy) {
    return (
      <div className="page page--missing">
        <PageHeader
          title={title}
          relativePath={basename}
          sessionPath={session.paths.session}
          pagePath={`${session.paths.session}/${basename}`}
          orchestratorPath={session.paths.orchestrator}
        />
        <div className="empty">
          <h2>Not found</h2>
          <p>
            <code>{basename}</code> does not exist in this session.
          </p>
        </div>
      </div>
    );
  }

  return (
    <article className="page">
      <PageHeader
        title={title}
        relativePath={basename}
        sessionPath={session.paths.session}
        pagePath={session.paths.spec[basename]!}
        orchestratorPath={session.paths.orchestrator}
      />
      <div className="page__body mdx-body">
        <Suspense fallback={<div className="page__loading">Loading {basename}…</div>}>
          <Lazy />
        </Suspense>
      </div>
    </article>
  );
}
