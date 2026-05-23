import { Component, type ReactNode, useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { CopyButton } from './CopyButton.js';

interface Props {
  open: boolean;
  /** Heading text shown in the drawer header. */
  title: string;
  /** Absolute path copied by the "Copy path" button. */
  path: string;
  /** Lazy loader for the orchestrator markdown. */
  loader: () => Promise<{ default: string }>;
  /** Called when the drawer requests close (ESC, backdrop, ✕). */
  onClose: () => void;
}

export function OrchestratorDrawer({ open, title, path, loader, onClose }: Props) {
  const [source, setSource] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Load markdown when opened. Re-runs if the loader identity changes
  // (i.e., the user opened a different phase orchestrator).
  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    setSource(null);
    setLoadError(null);
    loader()
      .then((mod) => {
        if (!cancelled) setSource(mod.default);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open, loader]);

  // ESC closes the drawer.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="drawer" role="dialog" aria-modal="true" aria-label={title}>
      <button
        type="button"
        className="drawer__backdrop"
        aria-label="Close orchestrator"
        onClick={onClose}
      />
      <aside className="drawer__panel">
        <header className="drawer__header">
          <h2 className="drawer__title">{title}</h2>
          <div className="drawer__actions">
            <CopyButton label="Copy path" value={path} />
            <button
              type="button"
              className="drawer__close"
              aria-label="Close"
              onClick={onClose}
            >
              ✕
            </button>
          </div>
        </header>
        <div className="drawer__body">
          {loadError ? (
            <div className="drawer__error">
              <p>Failed to load orchestrator: {loadError}</p>
              <p>
                <code>{path}</code>
              </p>
            </div>
          ) : source === null ? (
            <p className="drawer__loading">Loading orchestrator…</p>
          ) : (
            <MarkdownWithFallback source={source} />
          )}
        </div>
      </aside>
    </div>
  );
}

function MarkdownWithFallback({ source }: { source: string }) {
  return (
    <MarkdownErrorBoundary
      fallback={
        <pre className="drawer__raw">
          <code>{source}</code>
        </pre>
      }
    >
      <ReactMarkdown>{source}</ReactMarkdown>
    </MarkdownErrorBoundary>
  );
}

interface ErrorBoundaryProps {
  children: ReactNode;
  fallback: ReactNode;
}

class MarkdownErrorBoundary extends Component<
  ErrorBoundaryProps,
  { hasError: boolean }
> {
  override state = { hasError: false };
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  override render() {
    if (this.state.hasError) return this.props.fallback;
    return this.props.children;
  }
}
