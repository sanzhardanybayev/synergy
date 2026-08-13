/**
 * Regression test for a layout bug jsdom cannot see directly: jsdom computes no layout, so a pure
 * width/overflow assertion on rendered nodes would pass or fail identically regardless of the CSS.
 * `.review-diff` is `min-width: max-content` (needed so long CODE lines can scroll horizontally in
 * `.review-code-scroll`) - without a fix, `.review-removal` (a block child of that track) inherits
 * that same huge width, so its rationale sentence never wraps within the visible pane and runs off
 * the right edge, reachable only by horizontal scroll. The fix decouples `.review-removal`'s width
 * from that max-content ancestor by sizing it against `.review-code-scroll`'s own (visible) box via
 * a container query, and keeps it visually anchored to the left edge with `position: sticky`. This
 * test pins the CSS mechanism the fix depends on, so a regression that drops any piece of it (e.g.
 * reverting to a plain block child) fails here even though jsdom can't render the wrap itself.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const cssPath = resolve(process.cwd(), 'src/review/review.css');
const css = readFileSync(cssPath, 'utf8');

/** Extracts a top-level rule's declaration block body by selector, e.g. `.foo { a: b; }` -> `a: b;`. */
function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  if (!match) throw new Error(`No rule found for selector: ${selector}`);
  return match[1];
}

describe('review.css removal-strip width containment', () => {
  it('makes .review-code-scroll a container query context sized to its own visible box', () => {
    const body = ruleBody('.review-code-scroll');
    expect(body).toMatch(/container-type\s*:\s*inline-size/);
  });

  it('sizes .review-removal against the visible pane, not the max-content diff track', () => {
    const body = ruleBody('.review-removal');
    // Must NOT simply inherit width from `.review-diff` (min-width: max-content); it must be
    // explicitly sized against the query container's own (visible) inline size.
    expect(body).toMatch(/width\s*:\s*100cqw/);
  });

  it('keeps the strip anchored to the left edge while code rows scroll horizontally', () => {
    const body = ruleBody('.review-removal');
    expect(body).toMatch(/position\s*:\s*sticky/);
    expect(body).toMatch(/left\s*:\s*0/);
  });

  it('still lets .review-diff grow to max-content so code rows keep their own horizontal scroll', () => {
    const body = ruleBody('.review-diff,\n.review-source');
    expect(body).toMatch(/min-width\s*:\s*max-content/);
  });
});
