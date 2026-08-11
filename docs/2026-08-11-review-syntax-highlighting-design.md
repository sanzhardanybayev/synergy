# Review pane syntax highlighting

Date: 2026-08-11
Status: approved (design reviewed against a live side-by-side prototype)

## Problem

Every code surface in the review product renders one raw text node per line:

- `packages/preview/src/review/DiffViewer.tsx:55` - `<code>{row.text || ' '}</code>`
- `packages/preview/src/review/SourceViewer.tsx:48` - same shape
- `packages/vscode-extension/media/panel.js:231` - `el('span', { className: 'diff-text' }, [marker + line.text])`

The green/red add-remove tint is a row background, so a reviewer sees colored bands of undifferentiated
monospace text. Reading a hunk means parsing it unaided, which is exactly the work the review pane exists
to reduce.

## Decision

Highlight with **Shiki** (TextMate grammars) using the **JavaScript raw engine with precompiled
grammars** (`@shikijs/langs-precompiled`), themed with a custom **Ember & Graphite** theme pair derived
from the existing `--syn-*` design tokens.

### Why Shiki over Prism / highlight.js

1. **Per-line tokens.** `codeToTokens` returns `ThemedToken[][]`, already grouped by line. That drops
   directly into the existing `<code>` element inside each independently selectable row. Regex
   highlighters emit a single HTML blob per block; splitting it across rows means re-balancing spans by
   hand, and the review panes' whole interaction model is per-row selection.
2. **Multi-line correctness.** A stateful tokenizer keeps block comments and template literals right. The
   prototype demonstrated highlight.js, highlighting line by line, losing a JSDoc block after its first
   line and re-opening a comment inside a `/* not a comment */` sequence in a template literal.
3. **Accuracy.** Same grammars VS Code itself uses, so TSX, generics, decorators and `satisfies` render
   the way the reviewer's editor renders them.

The raw JS engine (`createJavaScriptRawEngine` from `shiki/engine/javascript`) is required, not
incidental: it removes the Oniguruma WASM dependency, so the VS Code webview keeps its strict CSP with
no `wasm-unsafe-eval` relaxation. Paired with precompiled grammars it also skips regex compilation at
runtime. All 34 languages in the curated set ship precompiled.

### Why a custom theme

`CLAUDE.md` forbids hardcoded palette hex in preview and spec-kit CSS. Shipping `github-dark` would import
a cool blue-grey scale into a warm paper/graphite product. The Ember & Graphite theme pair maps TextMate
scopes onto colors that already exist in `packages/preview/src/theme.css`:

| Scope group | Light | Dark | Token of origin |
|---|---|---|---|
| comment | `#8d8578` | `#8a8172` | `--syn-status-draft` / `--syn-fg-subtle` |
| string | `#22794a` | `#8fd6ac` | `--syn-success` / `--syn-diff-add-fg` |
| number, constant, attribute name | `#6d5bd0` | `#a394e8` | `--syn-status-proposed` |
| keyword, storage | `#a83f20` | `#ef9871` | `--syn-accent-strong` / `--syn-accent-fg` |
| function | `#17708b` | `#56aec9` | `--syn-status-shipped` |
| type, class, JSX tag | `#a16207` | `#d9a13c` | `--syn-warn` |
| object property | `#5f584e` | `#a89f92` | `--syn-fg-muted` |
| punctuation, operator | `#736b5d` | `#a89f92` | `--syn-fg-subtle` |
| plain identifier | `#211d18` | `#ece7df` | `--syn-fg` |

No new color is introduced. The theme is a projection of the existing scale, so a future palette change has
exactly one place to update.

## Architecture

### Shared unit: `@synergy/review-core/highlight`

A new browser-safe module - separate entry point, sibling to the existing `./browser` entry - owning:

- `resolveLanguage(path): BundledLanguage | undefined` - extension-to-grammar mapping, `undefined` for
  anything unknown.
- `emberGraphiteTheme(mode: 'light' | 'dark'): ThemeRegistration` - the theme pair above.
- `highlightLines(code, lang, mode): Promise<HighlightedLine[]>` - tokenizes a whole text once and returns
  one token array per line. `HighlightedLine = HighlightToken[]`, `HighlightToken = { text, color?, italic?, bold? }`.
  Deliberately a plain structural type: neither host leaks a Shiki type into its own components.
- `highlightHunk(rows, lang, mode)` - tokenizes a diff hunk as **two texts**, old side (context + removals)
  and new side (context + additions), then maps tokens back onto rows by index. Per-row tokenization would
  reproduce exactly the multi-line bug that ruled out the regex highlighters.
- An internal highlighter singleton plus a content-hash-keyed token cache, so re-renders and theme toggles
  do not re-tokenize unchanged text.

Both hosts consume this module. There is one implementation of language mapping, theming and hunk
splitting, so the two panes cannot drift.

The module owns a curated static language set (ts, tsx, js, jsx, json, jsonc, css, html, md, mdx, python,
go, rust, java, sh, yaml, sql, toml, diff). Static rather than lazily imported: it keeps the VS Code webview
a single script under its CSP, and keeps the module's contract synchronous-to-describe. Anything outside
the set falls back to plain text.

### Host 1: preview review pane

`DiffViewer` and `SourceViewer` render `<code>` exactly as today, except its children come from a
`useHighlightedLines` hook. The hook resolves the language from the file path, reads the active theme from
the existing `data-theme` attribute, and returns `undefined` until tokens resolve - during which the
components render today's plain text. Highlighting never gates first paint.

Row ids, selection state, gutters, diff tint and the captured text are untouched. A token span carries an
inline `color` and nothing else.

### Host 2: VS Code review pane

`media/panel.js` was shipped unbundled, so it could not import anything. The source moves to
`src/webview/panel.js` and `esbuild.mjs` gains a second entry that bundles it (with Shiki) back to
`media/panel.js`, which becomes a build artifact - gitignored, biome-ignored, and still the exact path
`webview-html.ts` addresses. `media/panel.css` continues to ship as a static asset. The strict CSP is
unchanged: no WASM, one nonce-tagged script, and token colors written through CSSOM because the CSP
blocks inline `style` attributes.

**Bundle size.** The webview cannot load code-split chunks under that CSP, so every grammar is inlined.
`media/panel.js` goes from 26 KB to 3.15 MB minified on disk, of which roughly 2.5 MB is grammars (C++
alone is 671 KB) and the rest is Shiki's runtime.

The shipped cost is far smaller than that number suggests, because grammars are repetitive JSON-shaped
data that deflates about 8.6x. Measured across the two packaged artifacts:

| | 0.17.0 | 0.18.0 |
| --- | --- | --- |
| `media/panel.js` (compressed in the `.vsix`) | 7.9 KB | 365 KB |
| `dist/extension.js` (compressed) | 72.5 KB | 72.5 KB - byte-identical |
| `.vsix` total | 86.6 KB | 433.7 KB |

So the extension grows by **~347 KB**, all of it `panel.js`; nothing else in the package changes. That is
accepted rather than mitigated by cutting languages - a review tool that cannot highlight C++ is the
worse outcome, the file is local to an installed extension, and grammar bodies are lazily compiled by the
JS engine so the runtime cost is a one-time parse. The sourcemap is excluded by `.vscodeignore`. The
browser preview is unaffected: Vite code-splits the same dynamic imports, so it fetches only the grammar
a file actually needs.

`hunkForItem`'s `.diff-text` span gains the same token children the preview renders.

### Failure behavior

Highlighting is presentation only. Unknown extension, binary file, a file over a size ceiling, or a
tokenizer throw all fall back to the current plain text node. No path can drop, reorder or rewrite a
captured line, and no path can fail a render.

## Testing

- `review-core`: language resolution incl. unknown extensions; theme pair shape; `highlightLines` preserving
  exact line count and concatenated text for every line (the safety invariant - tokens must reassemble into
  the original); `highlightHunk` mapping tokens to the correct side, verified with a hunk that removes a
  line from inside a block comment.
- `preview`: `DiffViewer`/`SourceViewer` render plain text before tokens resolve and token spans after;
  row ids and selection survive a theme flip.
- `vscode-extension`: the existing integration suite drives the real bundled webview inside a real
  Electron webview under the real CSP; one added case asserts that highlighting both ran (`.diff-marker`
  exists) and was permitted to color its tokens (a `span` carrying a `color`).

## Out of scope

- MDX code fences in spec sessions. Different render path, no request for it.
- Highlighting in the editor decorations (`src/editor/`), which use the real editor and are already themed.

## Release

Behavior change under `packages/` - `.claude-plugin/plugin.json` version bumps; lefthook derives the rest.
