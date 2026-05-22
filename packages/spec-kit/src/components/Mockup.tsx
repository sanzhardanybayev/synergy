import type { ReactNode } from 'react';

export interface MockupProps {
  /** Path to image relative to the session's `assets/` folder, or absolute URL. */
  src: string;
  alt: string;
  caption?: string;
  /** Optional max width in px or CSS unit. */
  maxWidth?: string;
  children?: ReactNode;
}

export function Mockup({ src, alt, caption, maxWidth, children }: MockupProps) {
  return (
    <figure className="sk-mockup">
      <img
        className="sk-mockup__image"
        src={src}
        alt={alt}
        style={maxWidth ? { maxWidth } : undefined}
      />
      {caption ? <figcaption className="sk-mockup__caption">{caption}</figcaption> : null}
      {children}
    </figure>
  );
}
