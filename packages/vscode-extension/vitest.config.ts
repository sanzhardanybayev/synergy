import { defineConfig } from 'vitest/config';

/**
 * `src/test` holds the extension-host integration suite: it requires a running VS Code (mocha
 * under @vscode/test-electron, see `pnpm test:integration`) and cannot run under vitest.
 */
export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', '**/dist/**', '**/out-test/**', 'src/test/**'],
    // `src/webview/panel.js` builds real DOM nodes (`document.createElement`, `classList`, …) -
    // its unit tests need jsdom. Every other suite in this package is a plain Node test.
    environmentMatchGlobs: [['src/webview/**', 'jsdom']],
  },
});
