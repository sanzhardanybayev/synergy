import type { ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import type { ChartKind } from '../types.js';

export interface ChartProps {
  /**
   * Diagram type. Drives the Mermaid prelude. If the source already begins
   * with a Mermaid directive (e.g. `graph TD`, `sequenceDiagram`), `kind` is
   * informational only.
   */
  kind?: ChartKind;
  /**
   * Mermaid source. Prefer placing it as children for multi-line diagrams.
   */
  source?: string;
  /** Optional caption shown under the chart. */
  caption?: string;
  children?: ReactNode;
}

// Lazily-loaded mermaid singleton so the package doesn't hard-depend on it.
type MermaidApi = {
  initialize: (cfg: { startOnLoad: boolean; theme?: string; securityLevel?: string }) => void;
  render: (id: string, src: string) => Promise<{ svg: string }>;
};
let mermaidPromise: Promise<MermaidApi> | null = null;

function loadMermaid(): Promise<MermaidApi> {
  if (mermaidPromise) return mermaidPromise;
  mermaidPromise = import('mermaid').then((m) => {
    const api = (m.default ?? (m as unknown)) as MermaidApi;
    api.initialize({ startOnLoad: false, theme: 'neutral', securityLevel: 'strict' });
    return api;
  });
  return mermaidPromise;
}

/**
 * Module-level cache: mermaid source → promise of its rendered SVG string.
 * It survives component remounts and route navigation, and dedupes in-flight
 * renders of identical sources — so revisiting a spec (or a duplicated chart)
 * never re-runs the expensive `mermaid.render()`.
 */
const renderCache = new Map<string, Promise<string>>();

/** Clear the chart render cache. Exposed for test isolation. */
export function __clearChartCache(): void {
  renderCache.clear();
}

/** djb2 hash → a stable, deterministic render id for a given source. */
function hashSource(src: string): string {
  let h = 5381;
  for (let i = 0; i < src.length; i++) h = (h * 33) ^ src.charCodeAt(i);
  return (h >>> 0).toString(36);
}

/** Render `source` to an SVG string, memoized (and in-flight-deduped) by source. */
function renderToSvg(source: string): Promise<string> {
  let cached = renderCache.get(source);
  if (!cached) {
    const renderId = `sk-chart-${hashSource(source)}`;
    cached = loadMermaid()
      .then((mermaid) => mermaid.render(renderId, source))
      .then(({ svg }) => svg);
    // Evict on failure so a later mount can retry instead of replaying the error.
    cached.catch(() => renderCache.delete(source));
    renderCache.set(source, cached);
  }
  return cached;
}

function extractSource(props: ChartProps): string {
  if (props.source) return props.source;
  if (typeof props.children === 'string') return props.children;
  if (Array.isArray(props.children)) {
    return props.children.filter((c) => typeof c === 'string').join('');
  }
  return '';
}

/**
 * Attach Mermaid-rendered SVG to a container by parsing it as a document and
 * extracting the <svg> root. Avoids innerHTML so we don't trip on any script
 * smuggling inside the rendered output.
 *
 * Parsed as `text/html`, not `image/svg+xml`: Mermaid 10+ renders any label
 * containing a line break as an HTML `<foreignObject>` holding `<p>...<br>...</p>`
 * with an unclosed `<br>`. Strict XML parsing rejects that and yields a
 * `<parsererror>` root, silently breaking the page. The HTML parser is lenient
 * about void elements and still produces a real, namespaced <svg> element.
 */
function attachSvg(container: HTMLDivElement, svgString: string) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(svgString, 'text/html');
  const svg = doc.body.querySelector('svg');
  if (!svg) throw new Error('Mermaid produced output without an <svg> element');
  // Strip any <script> elements as a belt-and-braces measure.
  for (const script of Array.from(svg.querySelectorAll('script'))) {
    script.remove();
  }
  while (container.firstChild) container.removeChild(container.firstChild);
  container.appendChild(svg);
}

export function Chart(props: ChartProps) {
  const { kind, caption } = props;
  const figureRef = useRef<HTMLElement | null>(null);
  const ref = useRef<HTMLDivElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [visible, setVisible] = useState(false);
  const source = extractSource(props).trim();

  // Defer rendering until the chart is near the viewport, so a chart-heavy spec
  // doesn't run every diagram up-front. Falls back to immediate render where
  // IntersectionObserver is unavailable (tests, SSR).
  useEffect(() => {
    const el = figureRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: '200px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!source || !visible) return;
    let cancelled = false;
    renderToSvg(source)
      .then((svg) => {
        if (cancelled || !ref.current) return;
        attachSvg(ref.current, svg);
        setError(null);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [source, visible]);

  return (
    <figure ref={figureRef} className="sk-chart" data-kind={kind ?? 'flow'}>
      <div ref={ref} className="sk-chart__svg" />
      {error ? (
        <pre className="sk-chart__error">
          {error}
          {'\n\n'}
          {source}
        </pre>
      ) : !source ? (
        <pre className="sk-chart__error">Chart: missing source</pre>
      ) : null}
      {caption ? <figcaption className="sk-chart__caption">{caption}</figcaption> : null}
    </figure>
  );
}
