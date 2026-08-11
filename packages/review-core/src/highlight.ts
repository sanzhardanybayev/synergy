/**
 * highlight.ts - the single syntax-highlighting implementation shared by both review surfaces:
 * the browser preview pane (`packages/preview/src/review/`) and the VS Code webview
 * (`packages/vscode-extension/media/panel.js`). Keeping language mapping, theming and diff-side
 * splitting here is what stops the two panes from drifting apart.
 *
 * Three deliberate choices:
 *
 * - **Shiki with the JavaScript RAW engine and precompiled grammars.** No Oniguruma WASM, so the
 *   VS Code webview keeps its strict CSP (no `wasm-unsafe-eval`), and no regex compilation at
 *   runtime.
 * - **Static language imports.** Bundlers resolve them ahead of time, so the webview stays one
 *   script rather than a script plus lazily fetched chunks it cannot address under that CSP.
 * - **Structural token type.** Callers see `HighlightToken`, never a Shiki type, so swapping the
 *   engine later does not ripple into either host's components.
 *
 * Highlighting is presentation only. Every failure path - unknown language, oversized input, a
 * throwing tokenizer - returns the original text as plain tokens, so no caller can lose a line.
 */

import { type HighlighterCore, type ThemeRegistrationRaw, createHighlighterCore } from 'shiki/core';
import { createJavaScriptRawEngine } from 'shiki/engine/javascript';

export type ThemeMode = 'light' | 'dark';

/** One styled run of text within a line. `color` absent means "inherit the pane's foreground". */
export interface HighlightToken {
  text: string;
  color?: string;
  italic?: boolean;
  bold?: boolean;
}

/** Tokens for a single line, in source order. Concatenating `text` rebuilds the line exactly. */
export type HighlightedLine = HighlightToken[];

/** The row shape `highlightHunk` needs: which side of the diff a row belongs to, plus its text. */
export interface HighlightHunkRow {
  kind: 'add' | 'remove' | 'context';
  text: string;
}

/**
 * Curated grammar set. Adding a language means one entry here and one extension below - there is
 * no per-host registration. Precompiled grammars are required by the raw engine.
 */
const GRAMMARS = {
  bash: () => import('@shikijs/langs-precompiled/bash'),
  c: () => import('@shikijs/langs-precompiled/c'),
  cpp: () => import('@shikijs/langs-precompiled/cpp'),
  csharp: () => import('@shikijs/langs-precompiled/csharp'),
  css: () => import('@shikijs/langs-precompiled/css'),
  diff: () => import('@shikijs/langs-precompiled/diff'),
  docker: () => import('@shikijs/langs-precompiled/docker'),
  go: () => import('@shikijs/langs-precompiled/go'),
  graphql: () => import('@shikijs/langs-precompiled/graphql'),
  html: () => import('@shikijs/langs-precompiled/html'),
  ini: () => import('@shikijs/langs-precompiled/ini'),
  java: () => import('@shikijs/langs-precompiled/java'),
  javascript: () => import('@shikijs/langs-precompiled/javascript'),
  json: () => import('@shikijs/langs-precompiled/json'),
  jsonc: () => import('@shikijs/langs-precompiled/jsonc'),
  jsx: () => import('@shikijs/langs-precompiled/jsx'),
  kotlin: () => import('@shikijs/langs-precompiled/kotlin'),
  lua: () => import('@shikijs/langs-precompiled/lua'),
  make: () => import('@shikijs/langs-precompiled/make'),
  markdown: () => import('@shikijs/langs-precompiled/markdown'),
  mdx: () => import('@shikijs/langs-precompiled/mdx'),
  php: () => import('@shikijs/langs-precompiled/php'),
  proto: () => import('@shikijs/langs-precompiled/proto'),
  python: () => import('@shikijs/langs-precompiled/python'),
  ruby: () => import('@shikijs/langs-precompiled/ruby'),
  rust: () => import('@shikijs/langs-precompiled/rust'),
  shellscript: () => import('@shikijs/langs-precompiled/shellscript'),
  sql: () => import('@shikijs/langs-precompiled/sql'),
  swift: () => import('@shikijs/langs-precompiled/swift'),
  toml: () => import('@shikijs/langs-precompiled/toml'),
  tsx: () => import('@shikijs/langs-precompiled/tsx'),
  typescript: () => import('@shikijs/langs-precompiled/typescript'),
  xml: () => import('@shikijs/langs-precompiled/xml'),
  yaml: () => import('@shikijs/langs-precompiled/yaml'),
} as const;

/** A grammar id this module can load. */
export type HighlightLanguage = keyof typeof GRAMMARS;

const EXTENSIONS: Record<string, HighlightLanguage> = {
  bash: 'bash',
  c: 'c',
  cc: 'cpp',
  cjs: 'javascript',
  cpp: 'cpp',
  cs: 'csharp',
  css: 'css',
  cts: 'typescript',
  diff: 'diff',
  go: 'go',
  graphql: 'graphql',
  gql: 'graphql',
  h: 'c',
  hpp: 'cpp',
  htm: 'html',
  html: 'html',
  ini: 'ini',
  java: 'java',
  js: 'javascript',
  json: 'json',
  json5: 'jsonc',
  jsonc: 'jsonc',
  jsx: 'jsx',
  kt: 'kotlin',
  kts: 'kotlin',
  lua: 'lua',
  markdown: 'markdown',
  md: 'markdown',
  mdx: 'mdx',
  mjs: 'javascript',
  mts: 'typescript',
  patch: 'diff',
  php: 'php',
  proto: 'proto',
  py: 'python',
  pyi: 'python',
  rb: 'ruby',
  rs: 'rust',
  scss: 'css',
  sh: 'shellscript',
  sql: 'sql',
  svg: 'xml',
  swift: 'swift',
  toml: 'toml',
  ts: 'typescript',
  tsx: 'tsx',
  xml: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
  zsh: 'shellscript',
};

/** Extensionless files worth recognizing by name. */
const FILENAMES: Record<string, HighlightLanguage> = {
  dockerfile: 'docker',
  gemfile: 'ruby',
  makefile: 'make',
  rakefile: 'ruby',
};

/**
 * Text longer than this is rendered plain. A review pane showing a megabyte-scale generated file
 * gains nothing from tokenizing it, and the cost lands on the UI thread of both hosts.
 */
const MAX_HIGHLIGHT_CHARS = 400_000;

/** Maps a repository path to a grammar, or `undefined` when nothing sensible applies. */
export function resolveLanguage(path: string): HighlightLanguage | undefined {
  const basename = path.split(/[\\/]/).pop()?.toLowerCase();
  if (!basename) return undefined;
  const byName = FILENAMES[basename];
  if (byName) return byName;
  const dot = basename.lastIndexOf('.');
  if (dot <= 0 || dot === basename.length - 1) return undefined;
  return EXTENSIONS[basename.slice(dot + 1)];
}

/**
 * The "Ember & Graphite" theme pair, projected from the design tokens in
 * `packages/preview/src/theme.css`. Every value below already exists in that file - this is a
 * mapping of scopes onto the palette, not a new palette, so a palette change has one home.
 */
export function emberGraphiteTheme(mode: ThemeMode): ThemeRegistrationRaw {
  const palette =
    mode === 'dark'
      ? {
          fg: '#ece7df', // --syn-fg
          comment: '#8a8172', // --syn-fg-subtle
          string: '#8fd6ac', // --syn-diff-add-fg
          constant: '#a394e8', // --syn-status-proposed
          keyword: '#ef9871', // --syn-accent-fg
          fn: '#56aec9', // --syn-status-shipped
          type: '#d9a13c', // --syn-warn
          property: '#a89f92', // --syn-fg-muted
          punctuation: '#a89f92', // --syn-fg-muted
          invalid: '#e0644e', // --syn-danger
        }
      : {
          fg: '#211d18', // --syn-fg
          comment: '#8d8578', // --syn-status-draft
          string: '#22794a', // --syn-success
          constant: '#6d5bd0', // --syn-status-proposed
          keyword: '#a83f20', // --syn-accent-strong
          fn: '#17708b', // --syn-status-shipped
          type: '#a16207', // --syn-warn
          property: '#5f584e', // --syn-fg-muted
          punctuation: '#736b5d', // --syn-fg-subtle
          invalid: '#c03a2b', // --syn-danger
        };

  return {
    name: `ember-graphite-${mode}`,
    type: mode,
    // Transparent: the row keeps its own background so diff add/remove tint stays visible.
    colors: { 'editor.foreground': palette.fg, 'editor.background': '#00000000' },
    settings: [
      { settings: { foreground: palette.fg } },
      {
        scope: ['comment', 'punctuation.definition.comment'],
        settings: { foreground: palette.comment, fontStyle: 'italic' },
      },
      {
        scope: [
          'string',
          'string.quoted',
          'string.template',
          'constant.character',
          'constant.other.symbol',
          'punctuation.definition.string',
          'meta.embedded.line.ruby',
        ],
        settings: { foreground: palette.string },
      },
      {
        scope: [
          'constant.numeric',
          'constant.language',
          'constant.other',
          'keyword.other.unit',
          'entity.other.attribute-name',
          'support.constant',
        ],
        settings: { foreground: palette.constant },
      },
      {
        scope: [
          'keyword',
          'keyword.control',
          'keyword.operator.new',
          'keyword.operator.expression',
          'storage',
          'storage.type',
          'storage.modifier',
          'markup.heading',
        ],
        settings: { foreground: palette.keyword },
      },
      {
        scope: [
          'entity.name.function',
          'support.function',
          'meta.function-call.generic',
          'variable.function',
          'markup.link',
        ],
        settings: { foreground: palette.fn },
      },
      {
        scope: [
          'entity.name.type',
          'entity.name.class',
          'entity.name.namespace',
          'entity.name.tag',
          'support.type',
          'support.class',
        ],
        settings: { foreground: palette.type },
      },
      {
        scope: [
          'variable.other.property',
          'variable.other.object.property',
          'meta.object-literal.key',
          'support.variable.property',
          'support.type.property-name',
        ],
        settings: { foreground: palette.property },
      },
      {
        scope: ['punctuation', 'meta.brace', 'keyword.operator'],
        settings: { foreground: palette.punctuation },
      },
      {
        scope: ['variable', 'variable.other', 'variable.parameter', 'entity.name.variable'],
        settings: { foreground: palette.fg },
      },
      { scope: ['invalid', 'invalid.illegal'], settings: { foreground: palette.invalid } },
    ],
  };
}

const THEMES: Record<ThemeMode, ThemeRegistrationRaw> = {
  light: emberGraphiteTheme('light'),
  dark: emberGraphiteTheme('dark'),
};

let highlighterPromise: Promise<HighlighterCore> | undefined;
const loadedLanguages = new Set<HighlightLanguage>();

/** One highlighter for the process; grammars attach to it on first use of each language. */
async function getHighlighter(): Promise<HighlighterCore> {
  highlighterPromise ??= createHighlighterCore({
    themes: [THEMES.light, THEMES.dark],
    langs: [],
    engine: createJavaScriptRawEngine(),
  });
  return highlighterPromise;
}

async function loadLanguage(highlighter: HighlighterCore, lang: HighlightLanguage): Promise<void> {
  if (loadedLanguages.has(lang)) return;
  await highlighter.loadLanguage(await GRAMMARS[lang]());
  loadedLanguages.add(lang);
}

/** Splits text the way a tokenizer would, so fallbacks match the shape of a successful run. */
function plainLines(code: string): HighlightedLine[] {
  return code.split('\n').map((text) => [{ text }]);
}

function isSupported(lang: string | undefined): lang is HighlightLanguage {
  return lang !== undefined && lang in GRAMMARS;
}

/**
 * Tokenizes `code` as a whole and returns one token array per line, so multi-line constructs
 * (block comments, template literals, heredocs) stay correct. Never throws: any failure degrades
 * to plain lines.
 */
export async function highlightLines(
  code: string,
  lang: string | undefined,
  mode: ThemeMode,
): Promise<HighlightedLine[]> {
  if (!isSupported(lang) || code.length > MAX_HIGHLIGHT_CHARS) return plainLines(code);
  try {
    const highlighter = await getHighlighter();
    await loadLanguage(highlighter, lang);
    const { tokens } = highlighter.codeToTokens(code, { lang, theme: THEMES[mode].name! });
    return tokens.map((line) =>
      line.map((token) => {
        const styled: HighlightToken = { text: token.content };
        if (token.color) styled.color = token.color;
        // Shiki encodes fontStyle as a bit field: 1 = italic, 2 = bold, 4 = underline.
        if (token.fontStyle !== undefined && token.fontStyle > 0) {
          if (token.fontStyle & 1) styled.italic = true;
          if (token.fontStyle & 2) styled.bold = true;
        }
        return styled;
      }),
    );
  } catch {
    return plainLines(code);
  }
}

/**
 * Tokenizes a diff hunk as its two sides - old (context + removals) and new (context + additions) -
 * and maps the results back onto the original rows.
 *
 * Highlighting each row on its own would be simpler and wrong: a removed line inside a block
 * comment, or a `/* ... *\/` sequence inside a template literal, only tokenizes correctly when the
 * side it belongs to is tokenized as continuous text.
 */
export async function highlightHunk(
  rows: readonly HighlightHunkRow[],
  lang: string | undefined,
  mode: ThemeMode,
): Promise<HighlightedLine[]> {
  if (!isSupported(lang)) return rows.map((row) => [{ text: row.text }]);

  const oldRowIndexes: number[] = [];
  const newRowIndexes: number[] = [];
  for (const [index, row] of rows.entries()) {
    if (row.kind !== 'add') oldRowIndexes.push(index);
    if (row.kind !== 'remove') newRowIndexes.push(index);
  }

  const [oldLines, newLines] = await Promise.all([
    highlightLines(oldRowIndexes.map((index) => rows[index]!.text).join('\n'), lang, mode),
    highlightLines(newRowIndexes.map((index) => rows[index]!.text).join('\n'), lang, mode),
  ]);

  const result: HighlightedLine[] = rows.map((row) => [{ text: row.text }]);
  // A side with no rows produces `['']` from split('\n'); indexing by position keeps them aligned.
  oldRowIndexes.forEach((rowIndex, position) => {
    const line = oldLines[position];
    if (line && rows[rowIndex]!.kind === 'remove') result[rowIndex] = line;
  });
  newRowIndexes.forEach((rowIndex, position) => {
    const line = newLines[position];
    if (line) result[rowIndex] = line;
  });
  return result;
}
