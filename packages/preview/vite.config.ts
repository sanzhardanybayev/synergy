import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import mdx from '@mdx-js/rollup';
import react from '@vitejs/plugin-react';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import { defineConfig } from 'vite';
import { rehypeSourceRange } from './src/rehype-source-range.js';
import { createRuntimeApiOptions } from './src/server/runtime-api.js';
import { buildFsAllowList } from './vite-fs-allow.js';
import { synergyEditPlugin } from './vite-plugin-edit.js';
import { synergySessionsPlugin } from './vite-plugin-sessions.js';

const require = createRequire(import.meta.url);
const specKitDir = dirname(require.resolve('@synergy/spec-kit/package.json'));

const projectRoot = process.env.SYNERGY_PROJECT_ROOT ?? process.cwd();
const sessionsDir =
  process.env.SYNERGY_SESSIONS_DIR ?? resolve(projectRoot, '.synergy', 'sessions');
const port = Number(process.env.SYNERGY_PORT ?? 4321);
const strictPort = process.env.SYNERGY_STRICT_PORT === 'true';

const runtime = createRuntimeApiOptions({
  instanceId: process.env.SYNERGY_INSTANCE_ID,
  projectId: process.env.SYNERGY_PROJECT_ID,
  controlToken: process.env.SYNERGY_CONTROL_TOKEN,
  pid: process.pid,
  port,
  async shutdown() {
    process.kill(process.pid, 'SIGTERM');
  },
});

export default defineConfig({
  root: __dirname,
  server: {
    port,
    strictPort,
    host: '127.0.0.1',
    fs: {
      // Allow vite to serve files outside of cwd: the sessions dir plus the
      // self-hosted font assets (see vite-fs-allow.ts).
      allow: buildFsAllowList(__dirname, projectRoot, sessionsDir),
    },
  },
  resolve: {
    alias: [
      // Always resolve spec-kit to a single instance regardless of where the
      // MDX file lives on disk.
      { find: /^@synergy\/spec-kit\/styles\.css$/, replacement: `${specKitDir}/dist/styles.css` },
      { find: /^@synergy\/spec-kit$/, replacement: `${specKitDir}/dist/index.js` },
      { find: '@synergy-sessions', replacement: sessionsDir },
    ],
    dedupe: ['react', 'react-dom'],
  },
  optimizeDeps: {
    include: ['react', 'react-dom', 'react-router-dom', 'mermaid'],
  },
  plugins: [
    {
      enforce: 'pre',
      ...mdx({
        providerImportSource: '@mdx-js/react',
        remarkPlugins: [[remarkFrontmatter, ['yaml']], remarkGfm],
        rehypePlugins: [rehypeSourceRange],
      }),
    },
    react(),
    synergySessionsPlugin({ sessionsDir }),
    synergyEditPlugin({ sessionsDir, projectRoot, runtime }),
  ],
});
