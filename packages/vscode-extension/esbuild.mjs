import esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

/**
 * Two bundles:
 *  - the extension host (Node, CommonJS, `vscode` external)
 *  - the webview script, bundled from `src/webview/panel.js` to `media/panel.js` because it now
 *    imports the shared syntax highlighter. It must stay a single classic script: the webview CSP
 *    allows exactly one nonce-tagged <script>, so no code splitting and no module format.
 */
const builds = [
  {
    entryPoints: ['src/extension.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    external: ['vscode'],
    outfile: 'dist/extension.js',
    sourcemap: true,
  },
  {
    entryPoints: ['src/webview/panel.js'],
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
    outfile: 'media/panel.js',
    sourcemap: true,
    // The grammars dominate this bundle and cannot be split out under the CSP, so minify to keep
    // the webview's parse cost down. The sourcemap keeps it debuggable.
    minify: true,
  },
];

const contexts = await Promise.all(builds.map((options) => esbuild.context(options)));
if (watch) {
  await Promise.all(contexts.map((context) => context.watch()));
} else {
  await Promise.all(contexts.map((context) => context.rebuild()));
  await Promise.all(contexts.map((context) => context.dispose()));
}
