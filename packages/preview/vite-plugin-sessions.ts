import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Plugin, ViteDevServer } from 'vite';

interface SessionMeta {
  name: string;
  /** Spec files in order, basename only. */
  specs: string[];
  /** True if orchestrator.md is present. */
  hasOrchestrator: boolean;
  /** mtime of the most recently modified file in the session. */
  lastModified: number;
}

interface PluginOptions {
  sessionsDir: string;
}

const MODULE_ID = 'virtual:synergy/sessions';
const RESOLVED_ID = `\0${MODULE_ID}`;

function buildIndex(sessionsDir: string): SessionMeta[] {
  if (!existsSync(sessionsDir)) return [];
  return readdirSync(sessionsDir)
    .filter((name) => {
      try {
        return statSync(join(sessionsDir, name)).isDirectory();
      } catch {
        return false;
      }
    })
    .map((name): SessionMeta => {
      const dir = join(sessionsDir, name);
      const entries = readdirSync(dir);
      const specs = entries.filter((f) => /\.mdx$/i.test(f)).sort();
      const hasOrchestrator = entries.includes('orchestrator.md');
      let lastModified = 0;
      for (const f of entries) {
        try {
          const s = statSync(join(dir, f));
          if (s.mtimeMs > lastModified) lastModified = s.mtimeMs;
        } catch {
          /* noop */
        }
      }
      return { name, specs, hasOrchestrator, lastModified };
    })
    .sort((a, b) => b.lastModified - a.lastModified);
}

export function synergySessionsPlugin(options: PluginOptions): Plugin {
  const { sessionsDir } = options;
  let server: ViteDevServer | undefined;

  function emitIndexModule(): string {
    const sessions = buildIndex(sessionsDir);
    // For each spec, emit a lazy import using `import.meta.glob` would force
    // us to hard-code patterns; we instead emit explicit dynamic imports per
    // session to keep glob globs minimal.
    const lines: string[] = [];
    lines.push(`export const SESSIONS_DIR = ${JSON.stringify(sessionsDir)};`);
    lines.push(`export const sessions = ${JSON.stringify(sessions, null, 2)};`);
    lines.push('');
    lines.push('export const loaders = {');
    for (const s of sessions) {
      lines.push(`  ${JSON.stringify(s.name)}: {`);
      for (const spec of s.specs) {
        const abs = join(sessionsDir, s.name, spec).replace(/\\/g, '/');
        lines.push(
          `    ${JSON.stringify(spec)}: () => import(${JSON.stringify(`/@fs${abs}`)}),`,
        );
      }
      if (s.hasOrchestrator) {
        const abs = join(sessionsDir, s.name, 'orchestrator.md').replace(/\\/g, '/');
        // Load as raw markdown.
        lines.push(
          `    "orchestrator.md": () => import(${JSON.stringify(`/@fs${abs}?raw`)}),`,
        );
      }
      lines.push('  },');
    }
    lines.push('};');
    return lines.join('\n');
  }

  return {
    name: 'synergy-sessions',
    resolveId(id) {
      if (id === MODULE_ID) return RESOLVED_ID;
      return null;
    },
    load(id) {
      if (id === RESOLVED_ID) return emitIndexModule();
      return null;
    },
    configureServer(devServer) {
      server = devServer;
      // Watch the sessions dir for additions / removals / changes.
      devServer.watcher.add(sessionsDir);
      const reload = (event: string, path: string) => {
        if (!path.startsWith(sessionsDir)) return;
        const rel = relative(sessionsDir, path);
        if (rel === '' || rel.startsWith('..')) return;
        // When a session is added/removed/renamed, invalidate the virtual module
        // and trigger a full reload.
        const mod = server!.moduleGraph.getModuleById(RESOLVED_ID);
        if (mod) server!.moduleGraph.invalidateModule(mod);
        if (event === 'add' || event === 'unlink' || event === 'addDir' || event === 'unlinkDir') {
          server!.ws.send({ type: 'full-reload' });
        }
      };
      devServer.watcher.on('add', (p) => reload('add', p));
      devServer.watcher.on('unlink', (p) => reload('unlink', p));
      devServer.watcher.on('addDir', (p) => reload('addDir', p));
      devServer.watcher.on('unlinkDir', (p) => reload('unlinkDir', p));
    },
    handleHotUpdate(ctx) {
      // For MDX files inside sessions: rely on Vite's default HMR via the
      // @mdx-js/rollup plugin (it already invalidates the module). Nothing
      // additional to do here.
      if (!ctx.file.startsWith(sessionsDir)) return undefined;
      return undefined;
    },
  };
}

// Export a helper to read orchestrator markdown server-side if needed elsewhere.
export function readOrchestrator(sessionDir: string): string | null {
  const path = join(sessionDir, 'orchestrator.md');
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf8');
}
