import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Plugin, ViteDevServer } from 'vite';

export interface PhaseMeta {
  /** Numeric ordering prefix parsed from the folder name (e.g. 1 for `01-core`). */
  order: number;
  /** Stable slug identifier (the folder name minus the `NN-` prefix). */
  slug: string;
  /** Folder name on disk (e.g. `01-core`). */
  folder: string;
  /** True if `orchestrator.md` is present inside the phase folder. */
  hasOrchestrator: boolean;
  /** Title from the phase `spec.mdx` YAML frontmatter, or humanized slug as fallback. */
  title: string;
}

export interface SessionPaths {
  /** Absolute path to the session directory. */
  session: string;
  /** Absolute paths to spec files keyed by basename (e.g. `00-overview.mdx`). */
  spec: Record<string, string>;
  /** Absolute path to root `orchestrator.md`, if present. */
  orchestrator?: string;
  /** Absolute paths to each phase's `spec.mdx`, keyed by phase slug. */
  phaseSpec: Record<string, string>;
  /** Absolute paths to each phase's `orchestrator.md`, keyed by phase slug. */
  phaseOrchestrator: Record<string, string>;
}

export interface SessionMeta {
  name: string;
  /** Spec files in the session root, in sort order, basename only. */
  specs: string[];
  /** True if root `orchestrator.md` is present. */
  hasOrchestrator: boolean;
  /** Phase metadata, sorted by `order`. */
  phases: PhaseMeta[];
  /** Absolute on-disk paths the page header needs. */
  paths: SessionPaths;
  /** mtime of the most recently modified file in the session (incl. phases). */
  lastModified: number;
}

interface PluginOptions {
  sessionsDir: string;
}

const MODULE_ID = 'virtual:synergy/sessions';
const RESOLVED_ID = `\0${MODULE_ID}`;

const PHASE_FOLDER_RE = /^(\d{1,3})-([a-z0-9-]+)$/i;

function safeStat(path: string) {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

function isDirectory(path: string): boolean {
  const s = safeStat(path);
  return s !== null && s.isDirectory();
}

function newestMtime(...paths: string[]): number {
  let max = 0;
  for (const p of paths) {
    const s = safeStat(p);
    if (s && s.mtimeMs > max) max = s.mtimeMs;
  }
  return max;
}

function humanizeSlug(slug: string): string {
  return slug
    .split('-')
    .filter(Boolean)
    .map((word) => (word.length ? word[0]!.toUpperCase() + word.slice(1) : word))
    .join(' ');
}

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---/;
const TITLE_RE = /^title\s*:\s*(.+?)\s*$/m;

/**
 * Parse the YAML frontmatter `title:` from a `spec.mdx` source. We do not pull
 * in a full YAML parser; this is best-effort and handles the common
 * `title: 'Foo'` / `title: "Foo"` / `title: Foo` forms.
 */
export function parsePhaseTitle(source: string): string | undefined {
  const block = FRONTMATTER_RE.exec(source);
  if (!block) return undefined;
  const titleMatch = TITLE_RE.exec(block[1]!);
  if (!titleMatch) return undefined;
  let raw = titleMatch[1]!.trim();
  if (
    (raw.startsWith("'") && raw.endsWith("'")) ||
    (raw.startsWith('"') && raw.endsWith('"'))
  ) {
    raw = raw.slice(1, -1);
  }
  return raw || undefined;
}

/**
 * Build the session index from disk. Exported as `__buildIndex` for unit tests.
 */
export function __buildIndex(sessionsDir: string): SessionMeta[] {
  if (!existsSync(sessionsDir)) return [];

  const sessionNames = readdirSync(sessionsDir).filter((name) =>
    isDirectory(join(sessionsDir, name)),
  );

  const sessions: SessionMeta[] = sessionNames.map((name): SessionMeta => {
    const dir = join(sessionsDir, name);
    const entries = readdirSync(dir);
    const specs = entries.filter((f) => /\.mdx$/i.test(f) && /^\d/.test(f)).sort();
    const hasOrchestrator = entries.includes('orchestrator.md');

    const phasesDir = join(dir, 'phases');
    const phases: PhaseMeta[] = [];
    if (isDirectory(phasesDir)) {
      const phaseEntries = readdirSync(phasesDir).filter((p) =>
        isDirectory(join(phasesDir, p)),
      );
      for (const folder of phaseEntries) {
        const match = PHASE_FOLDER_RE.exec(folder);
        if (!match) continue;
        const order = Number.parseInt(match[1]!, 10);
        const slug = match[2]!.toLowerCase();
        const phaseDir = join(phasesDir, folder);
        const specPath = join(phaseDir, 'spec.mdx');
        if (!existsSync(specPath)) continue;
        const orchestratorPath = join(phaseDir, 'orchestrator.md');
        const hasPhaseOrchestrator = existsSync(orchestratorPath);

        let title: string | undefined;
        try {
          title = parsePhaseTitle(readFileSync(specPath, 'utf8'));
        } catch {
          /* ignore parse errors */
        }

        phases.push({
          order,
          slug,
          folder,
          hasOrchestrator: hasPhaseOrchestrator,
          title: title ?? humanizeSlug(slug),
        });
      }
    }
    phases.sort((a, b) => a.order - b.order);

    const paths: SessionPaths = {
      session: dir,
      spec: {},
      phaseSpec: {},
      phaseOrchestrator: {},
    };
    for (const spec of specs) {
      paths.spec[spec] = join(dir, spec);
    }
    if (hasOrchestrator) paths.orchestrator = join(dir, 'orchestrator.md');
    for (const phase of phases) {
      paths.phaseSpec[phase.slug] = join(phasesDir, phase.folder, 'spec.mdx');
      if (phase.hasOrchestrator) {
        paths.phaseOrchestrator[phase.slug] = join(
          phasesDir,
          phase.folder,
          'orchestrator.md',
        );
      }
    }

    const allPaths: string[] = [
      dir,
      ...Object.values(paths.spec),
      ...(paths.orchestrator ? [paths.orchestrator] : []),
      ...Object.values(paths.phaseSpec),
      ...Object.values(paths.phaseOrchestrator),
    ];
    const lastModified = newestMtime(...allPaths);

    return { name, specs, hasOrchestrator, phases, paths, lastModified };
  });

  sessions.sort((a, b) => b.lastModified - a.lastModified);
  return sessions;
}

/**
 * Render the virtual module source. Loaders are emitted as explicit dynamic
 * imports so the bundler can produce per-file chunks.
 */
function emitIndexModule(sessionsDir: string): string {
  const sessions = __buildIndex(sessionsDir);
  const lines: string[] = [];
  lines.push(`export const SESSIONS_DIR = ${JSON.stringify(sessionsDir)};`);
  lines.push(`export const sessions = ${JSON.stringify(sessions, null, 2)};`);
  lines.push('');
  lines.push('export const loaders = {');
  for (const session of sessions) {
    lines.push(`  ${JSON.stringify(session.name)}: {`);

    lines.push('    spec: {');
    for (const spec of session.specs) {
      const abs = session.paths.spec[spec]!.replace(/\\/g, '/');
      lines.push(
        `      ${JSON.stringify(spec)}: () => import(${JSON.stringify(`/@fs${abs}`)}),`,
      );
    }
    lines.push('    },');

    if (session.paths.orchestrator) {
      const abs = session.paths.orchestrator.replace(/\\/g, '/');
      lines.push(
        `    orchestrator: () => import(${JSON.stringify(`/@fs${abs}?raw`)}),`,
      );
    }

    lines.push('    phaseSpec: {');
    for (const phase of session.phases) {
      const abs = session.paths.phaseSpec[phase.slug]!.replace(/\\/g, '/');
      lines.push(
        `      ${JSON.stringify(phase.slug)}: () => import(${JSON.stringify(`/@fs${abs}`)}),`,
      );
    }
    lines.push('    },');

    lines.push('    phaseOrchestrator: {');
    for (const phase of session.phases) {
      const abs = session.paths.phaseOrchestrator[phase.slug];
      if (!abs) continue;
      lines.push(
        `      ${JSON.stringify(phase.slug)}: () => import(${JSON.stringify(`/@fs${abs.replace(/\\/g, '/')}?raw`)}),`,
      );
    }
    lines.push('    },');

    lines.push('  },');
  }
  lines.push('};');
  return lines.join('\n');
}

export function synergySessionsPlugin(options: PluginOptions): Plugin {
  const { sessionsDir } = options;
  let server: ViteDevServer | undefined;

  return {
    name: 'synergy-sessions',
    resolveId(id) {
      if (id === MODULE_ID) return RESOLVED_ID;
      return null;
    },
    load(id) {
      if (id === RESOLVED_ID) return emitIndexModule(sessionsDir);
      return null;
    },
    configureServer(devServer) {
      server = devServer;
      devServer.watcher.add(sessionsDir);
      const reload = (event: string, path: string) => {
        if (!path.startsWith(sessionsDir)) return;
        const rel = relative(sessionsDir, path);
        if (rel === '' || rel.startsWith('..')) return;
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
      if (!ctx.file.startsWith(sessionsDir)) return undefined;
      return undefined;
    },
  };
}

/** Read root orchestrator markdown server-side if needed elsewhere. */
export function readOrchestrator(sessionDir: string): string | null {
  const path = join(sessionDir, 'orchestrator.md');
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf8');
}
