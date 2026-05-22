import type { ReactNode } from 'react';
import { useEffect, useId, useRef, useState } from 'react';
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
 * cloning the <svg> root. Avoids innerHTML so we don't trip on any script
 * smuggling inside the rendered output.
 */
function attachSvg(container: HTMLDivElement, svgString: string) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(svgString, 'image/svg+xml');
  const svg = doc.documentElement;
  // Strip any <script> elements as a belt-and-braces measure.
  for (const script of Array.from(svg.querySelectorAll('script'))) {
    script.remove();
  }
  while (container.firstChild) container.removeChild(container.firstChild);
  container.appendChild(svg);
}

export function Chart(props: ChartProps) {
  const { kind, caption } = props;
  const id = useId().replace(/[^a-zA-Z0-9-]/g, '');
  const ref = useRef<HTMLDivElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const source = extractSource(props).trim();

  useEffect(() => {
    let cancelled = false;
    if (!source) return;
    loadMermaid()
      .then((mermaid) => mermaid.render(`sk-chart-${id}`, source))
      .then(({ svg }) => {
        if (cancelled || !ref.current) return;
        attachSvg(ref.current, svg);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [id, source]);

  return (
    <figure className="sk-chart" data-kind={kind ?? 'flow'}>
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
