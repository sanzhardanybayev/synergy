// src/highlight.ts
import { createHighlighterCore } from "shiki/core";
import { createJavaScriptRawEngine } from "shiki/engine/javascript";
var GRAMMARS = {
  bash: () => import("@shikijs/langs-precompiled/bash"),
  c: () => import("@shikijs/langs-precompiled/c"),
  cpp: () => import("@shikijs/langs-precompiled/cpp"),
  csharp: () => import("@shikijs/langs-precompiled/csharp"),
  css: () => import("@shikijs/langs-precompiled/css"),
  diff: () => import("@shikijs/langs-precompiled/diff"),
  docker: () => import("@shikijs/langs-precompiled/docker"),
  go: () => import("@shikijs/langs-precompiled/go"),
  graphql: () => import("@shikijs/langs-precompiled/graphql"),
  html: () => import("@shikijs/langs-precompiled/html"),
  ini: () => import("@shikijs/langs-precompiled/ini"),
  java: () => import("@shikijs/langs-precompiled/java"),
  javascript: () => import("@shikijs/langs-precompiled/javascript"),
  json: () => import("@shikijs/langs-precompiled/json"),
  jsonc: () => import("@shikijs/langs-precompiled/jsonc"),
  jsx: () => import("@shikijs/langs-precompiled/jsx"),
  kotlin: () => import("@shikijs/langs-precompiled/kotlin"),
  lua: () => import("@shikijs/langs-precompiled/lua"),
  make: () => import("@shikijs/langs-precompiled/make"),
  markdown: () => import("@shikijs/langs-precompiled/markdown"),
  mdx: () => import("@shikijs/langs-precompiled/mdx"),
  php: () => import("@shikijs/langs-precompiled/php"),
  proto: () => import("@shikijs/langs-precompiled/proto"),
  python: () => import("@shikijs/langs-precompiled/python"),
  ruby: () => import("@shikijs/langs-precompiled/ruby"),
  rust: () => import("@shikijs/langs-precompiled/rust"),
  shellscript: () => import("@shikijs/langs-precompiled/shellscript"),
  sql: () => import("@shikijs/langs-precompiled/sql"),
  swift: () => import("@shikijs/langs-precompiled/swift"),
  toml: () => import("@shikijs/langs-precompiled/toml"),
  tsx: () => import("@shikijs/langs-precompiled/tsx"),
  typescript: () => import("@shikijs/langs-precompiled/typescript"),
  xml: () => import("@shikijs/langs-precompiled/xml"),
  yaml: () => import("@shikijs/langs-precompiled/yaml")
};
var EXTENSIONS = {
  bash: "bash",
  c: "c",
  cc: "cpp",
  cjs: "javascript",
  cpp: "cpp",
  cs: "csharp",
  css: "css",
  cts: "typescript",
  diff: "diff",
  go: "go",
  graphql: "graphql",
  gql: "graphql",
  h: "c",
  hpp: "cpp",
  htm: "html",
  html: "html",
  ini: "ini",
  java: "java",
  js: "javascript",
  json: "json",
  json5: "jsonc",
  jsonc: "jsonc",
  jsx: "jsx",
  kt: "kotlin",
  kts: "kotlin",
  lua: "lua",
  markdown: "markdown",
  md: "markdown",
  mdx: "mdx",
  mjs: "javascript",
  mts: "typescript",
  patch: "diff",
  php: "php",
  proto: "proto",
  py: "python",
  pyi: "python",
  rb: "ruby",
  rs: "rust",
  scss: "css",
  sh: "shellscript",
  sql: "sql",
  svg: "xml",
  swift: "swift",
  toml: "toml",
  ts: "typescript",
  tsx: "tsx",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
  zsh: "shellscript"
};
var FILENAMES = {
  dockerfile: "docker",
  gemfile: "ruby",
  makefile: "make",
  rakefile: "ruby"
};
var MAX_HIGHLIGHT_CHARS = 4e5;
function resolveLanguage(path) {
  const basename = path.split(/[\\/]/).pop()?.toLowerCase();
  if (!basename) return void 0;
  const byName = FILENAMES[basename];
  if (byName) return byName;
  const dot = basename.lastIndexOf(".");
  if (dot <= 0 || dot === basename.length - 1) return void 0;
  return EXTENSIONS[basename.slice(dot + 1)];
}
function emberGraphiteTheme(mode) {
  const palette = mode === "dark" ? {
    fg: "#ece7df",
    // --syn-fg
    comment: "#8a8172",
    // --syn-fg-subtle
    string: "#8fd6ac",
    // --syn-diff-add-fg
    constant: "#a394e8",
    // --syn-status-proposed
    keyword: "#ef9871",
    // --syn-accent-fg
    fn: "#56aec9",
    // --syn-status-shipped
    type: "#d9a13c",
    // --syn-warn
    property: "#a89f92",
    // --syn-fg-muted
    punctuation: "#a89f92",
    // --syn-fg-muted
    invalid: "#e0644e"
    // --syn-danger
  } : {
    fg: "#211d18",
    // --syn-fg
    comment: "#8d8578",
    // --syn-status-draft
    string: "#22794a",
    // --syn-success
    constant: "#6d5bd0",
    // --syn-status-proposed
    keyword: "#a83f20",
    // --syn-accent-strong
    fn: "#17708b",
    // --syn-status-shipped
    type: "#a16207",
    // --syn-warn
    property: "#5f584e",
    // --syn-fg-muted
    punctuation: "#736b5d",
    // --syn-fg-subtle
    invalid: "#c03a2b"
    // --syn-danger
  };
  return {
    name: `ember-graphite-${mode}`,
    type: mode,
    // Transparent: the row keeps its own background so diff add/remove tint stays visible.
    colors: { "editor.foreground": palette.fg, "editor.background": "#00000000" },
    settings: [
      { settings: { foreground: palette.fg } },
      {
        scope: ["comment", "punctuation.definition.comment"],
        settings: { foreground: palette.comment, fontStyle: "italic" }
      },
      {
        scope: [
          "string",
          "string.quoted",
          "string.template",
          "constant.character",
          "constant.other.symbol",
          "punctuation.definition.string",
          "meta.embedded.line.ruby"
        ],
        settings: { foreground: palette.string }
      },
      {
        scope: [
          "constant.numeric",
          "constant.language",
          "constant.other",
          "keyword.other.unit",
          "entity.other.attribute-name",
          "support.constant"
        ],
        settings: { foreground: palette.constant }
      },
      {
        scope: [
          "keyword",
          "keyword.control",
          "keyword.operator.new",
          "keyword.operator.expression",
          "storage",
          "storage.type",
          "storage.modifier",
          "markup.heading"
        ],
        settings: { foreground: palette.keyword }
      },
      {
        scope: [
          "entity.name.function",
          "support.function",
          "meta.function-call.generic",
          "variable.function",
          "markup.link"
        ],
        settings: { foreground: palette.fn }
      },
      {
        scope: [
          "entity.name.type",
          "entity.name.class",
          "entity.name.namespace",
          "entity.name.tag",
          "support.type",
          "support.class"
        ],
        settings: { foreground: palette.type }
      },
      {
        scope: [
          "variable.other.property",
          "variable.other.object.property",
          "meta.object-literal.key",
          "support.variable.property",
          "support.type.property-name"
        ],
        settings: { foreground: palette.property }
      },
      {
        scope: ["punctuation", "meta.brace", "keyword.operator"],
        settings: { foreground: palette.punctuation }
      },
      {
        scope: ["variable", "variable.other", "variable.parameter", "entity.name.variable"],
        settings: { foreground: palette.fg }
      },
      { scope: ["invalid", "invalid.illegal"], settings: { foreground: palette.invalid } }
    ]
  };
}
var THEMES = {
  light: emberGraphiteTheme("light"),
  dark: emberGraphiteTheme("dark")
};
var highlighterPromise;
var loadedLanguages = /* @__PURE__ */ new Set();
async function getHighlighter() {
  highlighterPromise ??= createHighlighterCore({
    themes: [THEMES.light, THEMES.dark],
    langs: [],
    engine: createJavaScriptRawEngine()
  });
  return highlighterPromise;
}
async function loadLanguage(highlighter, lang) {
  if (loadedLanguages.has(lang)) return;
  await highlighter.loadLanguage(await GRAMMARS[lang]());
  loadedLanguages.add(lang);
}
function plainLines(code) {
  return code.split("\n").map((text) => [{ text }]);
}
function isSupported(lang) {
  return lang !== void 0 && lang in GRAMMARS;
}
async function highlightLines(code, lang, mode) {
  if (!isSupported(lang) || code.length > MAX_HIGHLIGHT_CHARS) return plainLines(code);
  try {
    const highlighter = await getHighlighter();
    await loadLanguage(highlighter, lang);
    const { tokens } = highlighter.codeToTokens(code, { lang, theme: THEMES[mode].name });
    return tokens.map(
      (line) => line.map((token) => {
        const styled = { text: token.content };
        if (token.color) styled.color = token.color;
        if (token.fontStyle !== void 0 && token.fontStyle > 0) {
          if (token.fontStyle & 1) styled.italic = true;
          if (token.fontStyle & 2) styled.bold = true;
        }
        return styled;
      })
    );
  } catch {
    return plainLines(code);
  }
}
async function highlightHunk(rows, lang, mode) {
  if (!isSupported(lang)) return rows.map((row) => [{ text: row.text }]);
  const oldRowIndexes = [];
  const newRowIndexes = [];
  for (const [index, row] of rows.entries()) {
    if (row.kind !== "add") oldRowIndexes.push(index);
    if (row.kind !== "remove") newRowIndexes.push(index);
  }
  const [oldLines, newLines] = await Promise.all([
    highlightLines(oldRowIndexes.map((index) => rows[index].text).join("\n"), lang, mode),
    highlightLines(newRowIndexes.map((index) => rows[index].text).join("\n"), lang, mode)
  ]);
  const result = rows.map((row) => [{ text: row.text }]);
  oldRowIndexes.forEach((rowIndex, position) => {
    const line = oldLines[position];
    if (line && rows[rowIndex].kind === "remove") result[rowIndex] = line;
  });
  newRowIndexes.forEach((rowIndex, position) => {
    const line = newLines[position];
    if (line) result[rowIndex] = line;
  });
  return result;
}
export {
  emberGraphiteTheme,
  highlightHunk,
  highlightLines,
  resolveLanguage
};
//# sourceMappingURL=highlight.js.map