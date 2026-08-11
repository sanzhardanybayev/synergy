import * as _shikijs_langs_precompiled_yaml from '@shikijs/langs-precompiled/yaml';
import * as _shikijs_langs_precompiled_xml from '@shikijs/langs-precompiled/xml';
import * as _shikijs_langs_precompiled_typescript from '@shikijs/langs-precompiled/typescript';
import * as _shikijs_langs_precompiled_tsx from '@shikijs/langs-precompiled/tsx';
import * as _shikijs_langs_precompiled_toml from '@shikijs/langs-precompiled/toml';
import * as _shikijs_langs_precompiled_swift from '@shikijs/langs-precompiled/swift';
import * as _shikijs_langs_precompiled_sql from '@shikijs/langs-precompiled/sql';
import * as _shikijs_langs_precompiled_shellscript from '@shikijs/langs-precompiled/shellscript';
import * as _shikijs_langs_precompiled_rust from '@shikijs/langs-precompiled/rust';
import * as _shikijs_langs_precompiled_ruby from '@shikijs/langs-precompiled/ruby';
import * as _shikijs_langs_precompiled_python from '@shikijs/langs-precompiled/python';
import * as _shikijs_langs_precompiled_proto from '@shikijs/langs-precompiled/proto';
import * as _shikijs_langs_precompiled_php from '@shikijs/langs-precompiled/php';
import * as _shikijs_langs_precompiled_mdx from '@shikijs/langs-precompiled/mdx';
import * as _shikijs_langs_precompiled_markdown from '@shikijs/langs-precompiled/markdown';
import * as _shikijs_langs_precompiled_make from '@shikijs/langs-precompiled/make';
import * as _shikijs_langs_precompiled_lua from '@shikijs/langs-precompiled/lua';
import * as _shikijs_langs_precompiled_kotlin from '@shikijs/langs-precompiled/kotlin';
import * as _shikijs_langs_precompiled_jsx from '@shikijs/langs-precompiled/jsx';
import * as _shikijs_langs_precompiled_jsonc from '@shikijs/langs-precompiled/jsonc';
import * as _shikijs_langs_precompiled_json from '@shikijs/langs-precompiled/json';
import * as _shikijs_langs_precompiled_javascript from '@shikijs/langs-precompiled/javascript';
import * as _shikijs_langs_precompiled_java from '@shikijs/langs-precompiled/java';
import * as _shikijs_langs_precompiled_ini from '@shikijs/langs-precompiled/ini';
import * as _shikijs_langs_precompiled_html from '@shikijs/langs-precompiled/html';
import * as _shikijs_langs_precompiled_graphql from '@shikijs/langs-precompiled/graphql';
import * as _shikijs_langs_precompiled_go from '@shikijs/langs-precompiled/go';
import * as _shikijs_langs_precompiled_docker from '@shikijs/langs-precompiled/docker';
import * as _shikijs_langs_precompiled_diff from '@shikijs/langs-precompiled/diff';
import * as _shikijs_langs_precompiled_css from '@shikijs/langs-precompiled/css';
import * as _shikijs_langs_precompiled_csharp from '@shikijs/langs-precompiled/csharp';
import * as _shikijs_langs_precompiled_cpp from '@shikijs/langs-precompiled/cpp';
import * as _shikijs_langs_precompiled_c from '@shikijs/langs-precompiled/c';
import * as _shikijs_langs_precompiled_bash from '@shikijs/langs-precompiled/bash';
import { ThemeRegistrationRaw } from 'shiki/core';

type ThemeMode = 'light' | 'dark';
/** One styled run of text within a line. `color` absent means "inherit the pane's foreground". */
interface HighlightToken {
    text: string;
    color?: string;
    italic?: boolean;
    bold?: boolean;
}
/** Tokens for a single line, in source order. Concatenating `text` rebuilds the line exactly. */
type HighlightedLine = HighlightToken[];
/** The row shape `highlightHunk` needs: which side of the diff a row belongs to, plus its text. */
interface HighlightHunkRow {
    kind: 'add' | 'remove' | 'context';
    text: string;
}
/**
 * Curated grammar set. Adding a language means one entry here and one extension below - there is
 * no per-host registration. Precompiled grammars are required by the raw engine.
 */
declare const GRAMMARS: {
    readonly bash: () => Promise<typeof _shikijs_langs_precompiled_bash>;
    readonly c: () => Promise<typeof _shikijs_langs_precompiled_c>;
    readonly cpp: () => Promise<typeof _shikijs_langs_precompiled_cpp>;
    readonly csharp: () => Promise<typeof _shikijs_langs_precompiled_csharp>;
    readonly css: () => Promise<typeof _shikijs_langs_precompiled_css>;
    readonly diff: () => Promise<typeof _shikijs_langs_precompiled_diff>;
    readonly docker: () => Promise<typeof _shikijs_langs_precompiled_docker>;
    readonly go: () => Promise<typeof _shikijs_langs_precompiled_go>;
    readonly graphql: () => Promise<typeof _shikijs_langs_precompiled_graphql>;
    readonly html: () => Promise<typeof _shikijs_langs_precompiled_html>;
    readonly ini: () => Promise<typeof _shikijs_langs_precompiled_ini>;
    readonly java: () => Promise<typeof _shikijs_langs_precompiled_java>;
    readonly javascript: () => Promise<typeof _shikijs_langs_precompiled_javascript>;
    readonly json: () => Promise<typeof _shikijs_langs_precompiled_json>;
    readonly jsonc: () => Promise<typeof _shikijs_langs_precompiled_jsonc>;
    readonly jsx: () => Promise<typeof _shikijs_langs_precompiled_jsx>;
    readonly kotlin: () => Promise<typeof _shikijs_langs_precompiled_kotlin>;
    readonly lua: () => Promise<typeof _shikijs_langs_precompiled_lua>;
    readonly make: () => Promise<typeof _shikijs_langs_precompiled_make>;
    readonly markdown: () => Promise<typeof _shikijs_langs_precompiled_markdown>;
    readonly mdx: () => Promise<typeof _shikijs_langs_precompiled_mdx>;
    readonly php: () => Promise<typeof _shikijs_langs_precompiled_php>;
    readonly proto: () => Promise<typeof _shikijs_langs_precompiled_proto>;
    readonly python: () => Promise<typeof _shikijs_langs_precompiled_python>;
    readonly ruby: () => Promise<typeof _shikijs_langs_precompiled_ruby>;
    readonly rust: () => Promise<typeof _shikijs_langs_precompiled_rust>;
    readonly shellscript: () => Promise<typeof _shikijs_langs_precompiled_shellscript>;
    readonly sql: () => Promise<typeof _shikijs_langs_precompiled_sql>;
    readonly swift: () => Promise<typeof _shikijs_langs_precompiled_swift>;
    readonly toml: () => Promise<typeof _shikijs_langs_precompiled_toml>;
    readonly tsx: () => Promise<typeof _shikijs_langs_precompiled_tsx>;
    readonly typescript: () => Promise<typeof _shikijs_langs_precompiled_typescript>;
    readonly xml: () => Promise<typeof _shikijs_langs_precompiled_xml>;
    readonly yaml: () => Promise<typeof _shikijs_langs_precompiled_yaml>;
};
/** A grammar id this module can load. */
type HighlightLanguage = keyof typeof GRAMMARS;
/** Maps a repository path to a grammar, or `undefined` when nothing sensible applies. */
declare function resolveLanguage(path: string): HighlightLanguage | undefined;
/**
 * The "Ember & Graphite" theme pair, projected from the design tokens in
 * `packages/preview/src/theme.css`. Every value below already exists in that file - this is a
 * mapping of scopes onto the palette, not a new palette, so a palette change has one home.
 */
declare function emberGraphiteTheme(mode: ThemeMode): ThemeRegistrationRaw;
/**
 * Tokenizes `code` as a whole and returns one token array per line, so multi-line constructs
 * (block comments, template literals, heredocs) stay correct. Never throws: any failure degrades
 * to plain lines.
 */
declare function highlightLines(code: string, lang: string | undefined, mode: ThemeMode): Promise<HighlightedLine[]>;
/**
 * Tokenizes a diff hunk as its two sides - old (context + removals) and new (context + additions) -
 * and maps the results back onto the original rows.
 *
 * Highlighting each row on its own would be simpler and wrong: a removed line inside a block
 * comment, or a `/* ... *\/` sequence inside a template literal, only tokenizes correctly when the
 * side it belongs to is tokenized as continuous text.
 */
declare function highlightHunk(rows: readonly HighlightHunkRow[], lang: string | undefined, mode: ThemeMode): Promise<HighlightedLine[]>;

export { type HighlightHunkRow, type HighlightLanguage, type HighlightToken, type HighlightedLine, type ThemeMode, emberGraphiteTheme, highlightHunk, highlightLines, resolveLanguage };
