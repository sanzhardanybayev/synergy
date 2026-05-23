import { CopyButton } from './CopyButton.js';

interface Props {
  /** Human-readable page title (e.g. "Overview" or "Phase 2 — Core"). */
  title: string;
  /** Relative file path shown below the title (e.g. "00-overview.mdx"). */
  relativePath: string;
  /** Absolute path to the session directory. */
  sessionPath: string;
  /** Absolute path to the currently-rendered file. */
  pagePath: string;
  /**
   * Absolute path to the orchestrator that applies on this page. Omit to
   * hide the third copy button.
   */
  orchestratorPath?: string;
}

export function PageHeader({
  title,
  relativePath,
  sessionPath,
  pagePath,
  orchestratorPath,
}: Props) {
  return (
    <header className="page-header">
      <div className="page-header__text">
        <h1 className="page-header__title">{title}</h1>
        <code className="page-header__path">{relativePath}</code>
      </div>
      <div className="page-header__actions">
        <CopyButton label="Session path" value={sessionPath} />
        <CopyButton label="Current page path" value={pagePath} />
        {orchestratorPath ? (
          <CopyButton label="Orchestrator path" value={orchestratorPath} />
        ) : null}
      </div>
    </header>
  );
}
