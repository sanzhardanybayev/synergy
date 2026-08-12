/**
 * Hand-written type shadow for `panel.js`.
 *
 * `panel.js` is checked loosely (see tsconfig.media.json, `strict: false`) because it is
 * hand-written vanilla-DOM code, not TypeScript. That project is the source of truth for its
 * body. This file exists only so OTHER projects (`tsconfig.json`, `tsconfig.test.json`, both
 * `strict: true`) can resolve `import { renderDiffLines, renderRemovalStrip } from './panel.js'`
 * (see `src/webview/panel.test.ts`) without re-type-checking panel.js's body under strict mode,
 * which it was never written to satisfy. A `.d.ts` sitting beside a `.js` file with the same
 * basename takes priority over the `.js` file for type resolution - this file is never used at
 * runtime, only for `tsc`.
 */
export function renderDiffLines(
  hunk: { lines: unknown[] },
  path: string,
  context?: {
    reviewItemId: string;
    snapshot: unknown;
    insights: unknown;
    onJumpToReviewItem(reviewItemId: string): void;
    onOpenFile(path: string, line: number): void;
  },
): HTMLElement;

export function renderRemovalStrip(
  strip: {
    run: { start: number; end: number; lineIds: string[]; texts: string[] };
    rationale?: {
      reviewItemId: string;
      run: { path: string; start: number; end: number };
      reason: string;
      description: string;
      movedTo?: { path: string; start: number; end: number };
      movedToExcerpt?: { path: string; start: number; lines: string[] };
    };
    target:
      | {
          kind: 'in-review';
          reviewItemId: string;
          rowIds: string[];
          path: string;
          start: number;
          end: number;
        }
      | { kind: 'excerpt'; path: string; start: number; lines: string[] }
      | { kind: 'unresolved' };
  },
  handlers: {
    onJumpToReviewItem(reviewItemId: string): void;
    onOpenFile(path: string, line: number): void;
  },
): HTMLElement | null;
