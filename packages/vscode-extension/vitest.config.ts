import { defineConfig } from 'vitest/config';

/**
 * `src/test` holds the extension-host integration suite: it requires a running VS Code (mocha
 * under @vscode/test-electron, see `pnpm test:integration`) and cannot run under vitest.
 */
export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', '**/dist/**', '**/out-test/**', 'src/test/**'],
  },
});
