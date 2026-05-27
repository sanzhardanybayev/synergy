import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { dim, green, red, yellow } from 'kleur/colors';
import { PREVIEW_PORT, resolveProjectPaths } from './paths.js';

const require = createRequire(import.meta.url);

function readPid(pidFile: string): number | null {
  if (!existsSync(pidFile)) return null;
  const text = readFileSync(pidFile, 'utf8').trim();
  const pid = Number.parseInt(text, 10);
  if (!Number.isFinite(pid) || pid <= 0) return null;
  return pid;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function resolvePreviewEntry(): string {
  // @synergy/preview's vite config lives at packages/preview/. We resolve
  // its package.json then start vite from that directory.
  const previewPkg = require.resolve('@synergy/preview/package.json');
  return dirname(previewPkg);
}

function findViteBin(previewDir: string): string {
  // Walk up from previewDir looking for node_modules/.bin/vite
  let dir = previewDir;
  for (let i = 0; i < 6; i++) {
    const candidate = resolve(dir, 'node_modules', '.bin', 'vite');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `vite binary not found from ${previewDir}. Did you run \`pnpm install\` in the synergy workspace?`,
  );
}

export interface PreviewStartOptions {
  root?: string;
  port?: number;
  background?: boolean;
}

export interface PreviewStatus {
  running: boolean;
  pid: number | null;
  port: number;
  url: string;
}

export function previewStatus(root?: string, port = PREVIEW_PORT): PreviewStatus {
  const paths = resolveProjectPaths(root);
  const pid = readPid(paths.previewPidFile);
  const running = pid != null && isProcessAlive(pid);
  return { running, pid: running ? pid : null, port, url: `http://localhost:${port}` };
}

export function previewStart(opts: PreviewStartOptions = {}): PreviewStatus {
  const port = opts.port ?? PREVIEW_PORT;
  const paths = resolveProjectPaths(opts.root);
  const existing = previewStatus(paths.root, port);
  if (existing.running) {
    process.stdout.write(
      `${yellow('!')} Preview already running (pid ${existing.pid}) at ${existing.url}\n`,
    );
    return existing;
  }

  mkdirSync(paths.synergyDir, { recursive: true });
  // Clean up stale pidfile.
  if (existsSync(paths.previewPidFile)) unlinkSync(paths.previewPidFile);

  const previewDir = resolvePreviewEntry();
  const vite = findViteBin(previewDir);
  const logFd = openSync(paths.previewLogFile, 'a');

  const env = {
    ...process.env,
    SYNERGY_PROJECT_ROOT: paths.root,
    SYNERGY_SESSIONS_DIR: paths.sessionsDir,
    SYNERGY_PORT: String(port),
  };

  const child = spawn(vite, ['--port', String(port), '--strictPort'], {
    cwd: previewDir,
    env,
    detached: true,
    stdio: ['ignore', logFd, logFd],
  });
  child.unref();
  if (!child.pid) {
    throw new Error('Failed to spawn vite');
  }
  writeFileSync(paths.previewPidFile, String(child.pid));
  process.stdout.write(
    `${green('✓')} Preview started (pid ${child.pid}) at ${dim(`http://localhost:${port}`)}\n`,
  );
  process.stdout.write(`  Log: ${dim(paths.previewLogFile)}\n`);
  return { running: true, pid: child.pid, port, url: `http://localhost:${port}` };
}

export function previewStop(root?: string): boolean {
  const paths = resolveProjectPaths(root);
  const pid = readPid(paths.previewPidFile);
  if (!pid) {
    process.stdout.write(`${yellow('!')} No preview server recorded\n`);
    return false;
  }
  if (!isProcessAlive(pid)) {
    process.stdout.write(`${yellow('!')} Recorded pid ${pid} is not alive; cleaning up\n`);
    unlinkSync(paths.previewPidFile);
    return false;
  }
  try {
    process.kill(pid, 'SIGTERM');
    // Give it a moment, then check.
    setTimeout(() => {
      if (isProcessAlive(pid)) process.kill(pid, 'SIGKILL');
    }, 1500);
  } catch (err) {
    process.stdout.write(`${red('✗')} Failed to stop pid ${pid}: ${(err as Error).message}\n`);
    return false;
  }
  unlinkSync(paths.previewPidFile);
  process.stdout.write(`${green('✓')} Preview stopped (pid ${pid})\n`);
  return true;
}

export function printStatus(status: PreviewStatus) {
  if (status.running) {
    process.stdout.write(`${green('●')} running  pid ${status.pid}  ${status.url}\n`);
  } else {
    process.stdout.write(`${dim('○')} stopped  ${status.url}\n`);
  }
}
