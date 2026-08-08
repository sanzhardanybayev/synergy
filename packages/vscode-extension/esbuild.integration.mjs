import esbuild from 'esbuild';

/**
 * Bundles the extension-host integration suite into a single CommonJS file.
 *
 * VS Code `require`s `extensionTestsPath`, so the entry must be CJS - but `@synergy/review-core`
 * (which the suite uses to build fixtures and to read progress back off disk) is ESM-only.
 * Bundling resolves that mismatch. `mocha` stays external so it loads from node_modules with its
 * own dynamic requires intact.
 */
await esbuild.build({
  entryPoints: ['src/test/suite/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['vscode', 'mocha'],
  outfile: 'out-test/suite/index.js',
  sourcemap: true,
});
