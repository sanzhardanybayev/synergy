import type { ReactNode } from 'react';
import { ArrowUpRightIcon } from './icons.js';

export interface CrossRefProps {
  /**
   * Target reference. Format: `<slug>` or `<slug>#<anchor>`.
   * Slug is another spec file in the same session (without extension).
   * Anchor is a slugified heading inside that file.
   */
  to: string;
  /** Optional human label override. Defaults to children, then `to`. */
  label?: string;
  children?: ReactNode;
}

function targetToHref(to: string): string {
  const [slug, anchor] = to.split('#');
  const safeSlug = slug?.trim() ?? '';
  const safeAnchor = anchor?.trim();
  if (safeAnchor) return `#${safeSlug}--${safeAnchor}`;
  return `#${safeSlug}`;
}

export function CrossRef({ to, label, children }: CrossRefProps) {
  const text = children ?? label ?? to;
  return (
    <a className="sk-crossref" href={targetToHref(to)} data-crossref={to}>
      <span className="sk-crossref__icon" aria-hidden>
        <ArrowUpRightIcon size={12} />
      </span>
      <span className="sk-crossref__label">{text}</span>
    </a>
  );
}
