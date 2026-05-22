import { useEffect, useState } from 'react';
import { loaders } from 'virtual:synergy/sessions';

interface Props {
  sessionName: string;
}

export function OrchestratorPanel({ sessionName }: Props) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const loader = loaders[sessionName]?.['orchestrator.md'];
    if (!loader) {
      setError('No orchestrator.md in this session');
      return;
    }
    (loader() as Promise<{ default: string }>)
      .then((mod) => {
        if (!cancelled) setContent(mod.default);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [sessionName]);

  return (
    <aside className="orchestrator">
      <header className="orchestrator__header">
        <strong>Orchestrator</strong>
        <span className="orchestrator__hint">
          Read this before implementing. Plain markdown — not rendered.
        </span>
      </header>
      <pre className="orchestrator__source">
        <code>{error ?? content ?? 'Loading…'}</code>
      </pre>
    </aside>
  );
}
