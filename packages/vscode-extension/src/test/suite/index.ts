import Mocha from 'mocha';

/**
 * Entry point VS Code `require`s inside the extension host (`extensionTestsPath`).
 *
 * Test files are imported explicitly rather than glob-discovered because this file is bundled by
 * esbuild (so the ESM-only `@synergy/review-core` can be reached from the CommonJS extension
 * host); a runtime glob would find nothing inside a bundle. Add new suites to `SUITES`.
 *
 * Mocha normally installs its `describe`/`it` globals while it loads test FILES from disk. Since
 * the suites arrive as bundled imports instead, we emit `pre-require` ourselves first - the same
 * hook `Mocha.loadFiles` fires - and only then import them.
 */
export async function run(): Promise<void> {
  const mocha = new Mocha({
    ui: 'bdd',
    color: true,
    // The first test waits on a real extension activation plus a real webview load; the default
    // 2s timeout is far too tight for that.
    timeout: 60_000,
    slow: 5_000,
  });

  mocha.suite.emit('pre-require', globalThis, '', mocha);
  await import('./review-panel.test.js');

  return new Promise<void>((resolve, reject) => {
    mocha.run((failures) => {
      if (failures > 0) reject(new Error(`${failures} integration test(s) failed.`));
      else resolve();
    });
  });
}
