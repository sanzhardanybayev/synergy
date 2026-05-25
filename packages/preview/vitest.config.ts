import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.{ts,tsx}'],
    environmentMatchGlobs: [
      // Server-side handler tests need the Node.js runtime, not jsdom.
      ['tests/server/**', 'node'],
      // All other tests (React components, etc.) use jsdom.
      ['tests/**', 'jsdom'],
    ],
  },
});
