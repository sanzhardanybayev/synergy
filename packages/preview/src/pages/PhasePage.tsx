import { loaders } from 'virtual:synergy/sessions';
import { MDXProvider } from '@mdx-js/react';
import {
  type ComponentType,
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { useParams } from 'react-router-dom';
import { CommentHighlights } from '../CommentHighlights.js';
import { CommentLayer } from '../CommentLayer.js';
import { DiffOverlay } from '../DiffOverlay.js';
import { useEditBuffer } from '../EditBuffer.js';
import { PageHeader } from '../PageHeader.js';
import { useSession } from '../SessionShell.js';
import { TopToolbar } from '../TopToolbar.js';
import { getSource } from '../api.js';
import { mdxComponents } from '../mdx-components.js';

export function PhasePage() {
  const { phaseSlug = '' } = useParams<{ phaseSlug: string }>();
  const { session } = useSession();
  const buffer = useEditBuffer();
  // Stable setters — see SpecPage note: depending on `buffer` in effects loops.
  const { setCurrentFile, setFileSource, setDiffMode, bumpCommentRefresh } = buffer;

  const phase = session.phases.find((p) => p.slug === phaseSlug) ?? null;
  const sessionLoaders = loaders[session.name];
  const loader = phase ? sessionLoaders?.phaseSpec[phase.slug] : undefined;

  // sessionsDirRelativeFile: used for api.getSource, putEdit, DiffOverlay.
  // e.g. "2026-05-25-foo/phases/01-core/spec.mdx"
  const sessionsDirRelativeFile = phase ? `${session.name}/phases/${phase.folder}/spec.mdx` : '';

  // sessionRelativeFile: used for CommentLayer.
  // e.g. "phases/01-core/spec.mdx"
  const sessionRelativeFile = phase ? `phases/${phase.folder}/spec.mdx` : '';

  const [fileSource, setFileSourceLocal] = useState('');
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [diffOn, setDiffOn] = useState(false);
  // Inform the buffer which file is current.
  useEffect(() => {
    if (!sessionsDirRelativeFile) return;
    setCurrentFile(sessionsDirRelativeFile);
  }, [sessionsDirRelativeFile, setCurrentFile]);

  // Fetch raw source.
  useEffect(() => {
    if (!sessionsDirRelativeFile) return;
    let cancelled = false;
    getSource(sessionsDirRelativeFile)
      .then((src) => {
        if (!cancelled) {
          setFileSourceLocal(src);
          setFileSource(src);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setSourceError(err instanceof Error ? err.message : 'Failed to load source');
          // Clear stale source (see SpecPage note) to avoid spurious 409 on Apply.
          setFileSource('');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [sessionsDirRelativeFile, setFileSource]);

  const handleToggleDiff = useCallback(() => {
    const next = !diffOn;
    setDiffOn(next);
    setDiffMode(next);
  }, [diffOn, setDiffMode]);

  const handleCommentPosted = useCallback(() => {
    bumpCommentRefresh();
  }, [bumpCommentRefresh]);

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

      <TopToolbar
        openComments={buffer.openCommentCount}
        diffOn={diffOn}
        onToggleDiff={handleToggleDiff}
      />

      {sourceError && (
        <p className="page__source-error" role="alert">
          Source load error: {sourceError}
        </p>
      )}

      <div className="page__body mdx-body">
        <MDXProvider components={mdxComponents}>
          <Suspense fallback={<div className="page__loading">Loading {relativePath}…</div>}>
            <Lazy />
          </Suspense>
        </MDXProvider>
      </div>

      {diffOn && <DiffOverlay files={[sessionsDirRelativeFile]} />}

      {sessionRelativeFile && fileSource && (
        <CommentHighlights
          session={session.name}
          file={sessionRelativeFile}
          fileSource={fileSource}
        />
      )}

      {sessionRelativeFile && (
        <CommentLayer
          session={session.name}
          file={sessionRelativeFile}
          fileSource={fileSource}
          onPosted={handleCommentPosted}
        />
      )}
    </article>
  );
}
