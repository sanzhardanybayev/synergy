import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    browser: 'src/browser.ts',
    highlight: 'src/highlight.ts',
    'source-capture-worker': 'src/source-capture-worker.ts',
  },
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
});
