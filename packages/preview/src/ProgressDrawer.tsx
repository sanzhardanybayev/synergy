import { useEffect } from 'react';
import type { ProgressDto } from './api.js';
import { XIcon } from './icons.js';

interface Props {
  open: boolean;
  data: ProgressDto | null;
  onClose: () => void;
}

export function ProgressDrawer({ open, data, onClose }: Props) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const derived = data?.derived ?? { done: 0, total: 0, percent: 0 };
  const roster = data?.roster ?? [];
  const legacyPhases = data?.progress.phases ?? [];
  const resume = data?.progress.resume ?? {};
  const rows =
    roster.length > 0
      ? roster.map((r) => ({ slug: r.slug, status: r.status, label: r.title }))
      : legacyPhases.map((p) => ({ slug: p.slug, status: p.status, label: p.slug }));

  return (
    // biome-ignore lint/a11y/useSemanticElements: role=dialog matches OrchestratorDrawer pattern
    <div className="drawer" role="dialog" aria-modal="true" aria-label="Execution progress">
      <button
        type="button"
        className="drawer__backdrop"
        aria-label="Close progress"
        onClick={onClose}
      />
      <aside className="drawer__panel">
        <header className="drawer__header">
          <h2 className="drawer__title">Progress</h2>
          <button type="button" className="drawer__close" aria-label="Close" onClick={onClose}>
            <XIcon size={16} />
          </button>
        </header>
        <div className="drawer__body">
          <div className="progress-rollup">
            <div className="progress-rollup__bar" aria-hidden="true">
              <div className="progress-rollup__fill" style={{ width: `${derived.percent}%` }} />
            </div>
            <p className="progress-rollup__label">
              {derived.done} / {derived.total} phases done ({derived.percent}%)
            </p>
          </div>

          {(resume.nextPhase || resume.note) && (
            <div className="progress-resume">
              <strong>Next:</strong> {resume.nextPhase ?? '—'}
              {resume.note ? ` — ${resume.note}` : ''}
            </div>
          )}

          <ul className="progress-phases">
            {rows.map((p) => (
              <li key={p.slug} className="progress-phases__item">
                <span className={`sk-status sk-status--${p.status}`} data-status={p.status}>
                  <span className="sk-status__dot" aria-hidden />
                  {p.status}
                </span>
                <span className="progress-phases__slug">{p.label}</span>
                {data?.phaseJournals[p.slug] ? (
                  <details className="progress-phases__journal">
                    <summary>journal</summary>
                    <pre>{data.phaseJournals[p.slug]}</pre>
                  </details>
                ) : null}
              </li>
            ))}
          </ul>

          {data?.globalJournal ? (
            <div className="progress-global">
              <h3>Cross-cutting log</h3>
              <pre>{data.globalJournal}</pre>
            </div>
          ) : null}
        </div>
      </aside>
    </div>
  );
}
