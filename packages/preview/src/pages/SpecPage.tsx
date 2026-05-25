import { loaders } from 'virtual:synergy/sessions';
import { MDXProvider } from '@mdx-js/react';
import {
  type ComponentType,
  type ReactNode,
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { CommentLayer } from '../CommentLayer.js';
import { DiffOverlay } from '../DiffOverlay.js';
import { useEditBuffer } from '../EditBuffer.js';
import { PageHeader } from '../PageHeader.js';
import { useSession } from '../SessionShell.js';
import { TopToolbar } from '../TopToolbar.js';
import { getSource } from '../api.js';
import { mdxComponents } from '../mdx-components.js';

interface Props {
  basename: '00-overview.mdx' | '01-architecture.mdx' | '02-implementation.mdx';
  title: string;
  /** Optional secondary content (e.g., phase index callouts) below the MDX. */
  children?: ReactNode;
}

export function SpecPage({ basename, title }: Props) {
  const { session } = useSession();
  const buffer = useEditBuffer();
  // Destructure the stable setters: depending on the whole `buffer` object in
  // effects/callbacks re-fires them on every buffer state change (the context
  // value identity churns), causing redundant renders + duplicate fetches.
  const { setCurrentFile, setFileSource, setDiffMode, bumpCommentRefresh } = buffer;
  const hasFile = session.specs.includes(basename);
  const sessionLoaders = loaders[session.name];
  const loader = sessionLoaders?.spec[basename];

  // sessionsDirRelativeFile: used for api.getSource, putEdit, DiffOverlay.
  // e.g. "2026-05-25-foo/00-overview.mdx"
  const sessionsDirRelativeFile = `${session.name}/${basename}`;

  // sessionRelativeFile: used for CommentLayer.
  // e.g. "00-overview.mdx"
  const sessionRelativeFile = basename;

  const [fileSource, setFileSourceLocal] = useState('');
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [diffOn, setDiffOn] = useState(false);

  // Inform the buffer which file is current (for EditableBlock key computation).
  useEffect(() => {
    if (!hasFile) return;
    setCurrentFile(sessionsDirRelativeFile);
  }, [sessionsDirRelativeFile, hasFile, setCurrentFile]);

  // Fetch raw source for expectedText computation.
  useEffect(() => {
    if (!hasFile) return;
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
          // Clear stale source so EditableBlock can't compute expectedText against
          // an outdated file (which would 409 on every Apply).
          setFileSource('');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [sessionsDirRelativeFile, hasFile, setFileSource]);

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
          <Suspense fallback={<div className="page__loading">Loading {basename}…</div>}>
            <Lazy />
          </Suspense>
        </MDXProvider>
      </div>

      {diffOn && <DiffOverlay files={[sessionsDirRelativeFile]} />}

      <CommentLayer
        session={session.name}
        file={sessionRelativeFile}
        fileSource={fileSource}
        onPosted={handleCommentPosted}
      />
    </article>
  );
}
