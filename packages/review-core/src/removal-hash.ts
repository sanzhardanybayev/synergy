import { hashText } from './hash.js';

/**
 * Identity for carry-forward matching: depends only on the ordered removed text, never on line
 * numbers, so a pure offset shift (e.g. an unrelated edit above the run) still matches.
 *
 * Split into its own module (rather than living in `removals.ts`) because it is the only piece
 * of the removal-derivation surface that needs `hashText` (`node:crypto`). `removals.ts` is
 * imported by the browser-safe entry point (`browser.ts`) for the preview app and VS Code
 * webview; those bundlers fail to resolve `node:crypto` even for unused exports, so any
 * node-only import at the top of `removals.ts` would break both hosts. Keeping this one function
 * in its own file keeps `removals.ts` importable from `browser.ts` without pulling in Node
 * built-ins.
 */
export function removalRunHash(texts: readonly string[]): string {
  return hashText(texts.join('\n'));
}
