import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    format: ['esm'],
    dts: true,
    sourcemap: true,
    clean: true,
    external: ['@synergy/spec-kit', '@synergy/validator', '@synergy/preview'],
  },
  {
    entry: { cli: 'src/cli.ts' },
    format: ['esm'],
    dts: false,
    sourcemap: true,
    clean: false,
    banner: { js: '#!/usr/bin/env node' },
    external: ['@synergy/spec-kit', '@synergy/validator', '@synergy/preview'],
  },
]);
