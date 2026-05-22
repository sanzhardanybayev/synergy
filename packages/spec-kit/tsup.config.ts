import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'components/index': 'src/components/index.ts',
    'schemas-index': 'src/schemas-index.ts',
  },
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  external: ['react', 'react-dom', 'mermaid'],
  loader: { '.css': 'copy' },
  publicDir: false,
  onSuccess: 'cp src/styles.css dist/styles.css',
});
