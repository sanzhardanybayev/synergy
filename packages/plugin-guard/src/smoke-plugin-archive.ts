import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REQUIRED_RUNTIME_ARTIFACTS } from './artifacts.js';

export interface SmokeCommand {
  command: string;
  args: string[];
  cwd: string;
}

export interface SmokeCommandResult {
  stdout: string;
}

export type SmokeCommandRunner = (
  invocation: SmokeCommand,
) => Promise<SmokeCommandResult> | SmokeCommandResult;

export interface PluginArchiveSmokeOptions {
  repositoryRoot?: string;
  temporaryRoot?: string;
  runCommand?: SmokeCommandRunner;
  fetch?: typeof globalThis.fetch;
}

const CLI_PATH = 'packages/cli/dist/cli.js';
const RUNTIME_FILE = '.synergy/preview.runtime.json';

function defaultCommandRunner(invocation: SmokeCommand): SmokeCommandResult {
  return {
    stdout: execFileSync(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      encoding: 'utf8',
      env: { ...process.env, CI: '1' },
      maxBuffer: 10 * 1024 * 1024,
    }),
  };
}

function assertRequiredArtifacts(archiveRoot: string): void {
  for (const artifact of REQUIRED_RUNTIME_ARTIFACTS) {
    const path = join(archiveRoot, artifact);
    if (!existsSync(path) || !statSync(path).isFile()) {
      throw new Error(`Archive is missing required runtime artifact: ${artifact}`);
    }
  }
}

function artifactChecksums(archiveRoot: string): Map<string, string> {
  return new Map(
    REQUIRED_RUNTIME_ARTIFACTS.map((artifact) => [
      artifact,
      createHash('sha256')
        .update(readFileSync(join(archiveRoot, artifact)))
        .digest('hex'),
    ]),
  );
}

function assertChecksumsUnchanged(archiveRoot: string, before: Map<string, string>): void {
  for (const [artifact, expected] of before) {
    const path = join(archiveRoot, artifact);
    const actual = existsSync(path)
      ? createHash('sha256').update(readFileSync(path)).digest('hex')
      : null;
    if (actual !== expected) {
      throw new Error(`Runtime artifact changed during archive smoke: ${artifact}`);
    }
  }
}

function readRuntimeOrigin(fixtureRoot: string): string {
  const payload: unknown = JSON.parse(readFileSync(join(fixtureRoot, RUNTIME_FILE), 'utf8'));
  if (
    typeof payload !== 'object' ||
    payload === null ||
    !('origin' in payload) ||
    typeof payload.origin !== 'string'
  ) {
    throw new Error('Preview did not publish a runtime origin');
  }

  const origin = new URL(payload.origin);
  if (
    origin.protocol !== 'http:' ||
    origin.hostname !== '127.0.0.1' ||
    origin.origin !== payload.origin
  ) {
    throw new Error('Preview published an invalid runtime origin');
  }
  return origin.origin;
}

async function assertHealthyPreview(origin: string, fetch: typeof globalThis.fetch): Promise<void> {
  const response = await fetch(new URL('/api/runtime/health', origin));
  if (!response.ok) throw new Error(`Preview health check failed with HTTP ${response.status}`);
  const payload: unknown = await response.json();
  if (
    typeof payload !== 'object' ||
    payload === null ||
    !('state' in payload) ||
    payload.state !== 'ready'
  ) {
    throw new Error('Preview health check did not report ready');
  }
}

async function prepareStagedFixture(
  fixtureRoot: string,
  runCommand: SmokeCommandRunner,
): Promise<void> {
  mkdirSync(fixtureRoot, { recursive: true });
  writeFileSync(join(fixtureRoot, 'tracked.txt'), 'before\n', 'utf8');
  await runCommand({ command: 'git', args: ['init', '--quiet'], cwd: fixtureRoot });
  await runCommand({
    command: 'git',
    args: ['config', 'user.email', 'archive-smoke@example.test'],
    cwd: fixtureRoot,
  });
  await runCommand({
    command: 'git',
    args: ['config', 'user.name', 'Archive Smoke'],
    cwd: fixtureRoot,
  });
  await runCommand({ command: 'git', args: ['add', '--', 'tracked.txt'], cwd: fixtureRoot });
  await runCommand({
    command: 'git',
    args: ['commit', '--quiet', '-m', 'baseline'],
    cwd: fixtureRoot,
  });
  writeFileSync(join(fixtureRoot, 'staged.txt'), 'staged review change\n', 'utf8');
  await runCommand({ command: 'git', args: ['add', '--', 'staged.txt'], cwd: fixtureRoot });
}

export async function runPluginArchiveSmoke(
  options: PluginArchiveSmokeOptions = {},
): Promise<void> {
  const repositoryRoot = resolve(options.repositoryRoot ?? process.cwd());
  const ownsTemporaryRoot = options.temporaryRoot === undefined;
  const temporaryRoot =
    options.temporaryRoot ?? mkdtempSync(join(tmpdir(), 'synergy-plugin-archive-'));
  const runCommand = options.runCommand ?? defaultCommandRunner;
  const fetch = options.fetch ?? globalThis.fetch;
  const archiveTar = join(temporaryRoot, 'plugin.tar');
  const archiveRoot = join(temporaryRoot, 'archive');
  const fixtureRoot = join(temporaryRoot, 'consumer');

  mkdirSync(archiveRoot, { recursive: true });
  try {
    await runCommand({
      command: 'git',
      args: ['archive', '--format=tar', '--output', archiveTar, 'HEAD'],
      cwd: repositoryRoot,
    });
    await runCommand({
      command: 'tar',
      args: ['-xf', archiveTar, '-C', archiveRoot],
      cwd: temporaryRoot,
    });

    assertRequiredArtifacts(archiveRoot);
    const checksums = artifactChecksums(archiveRoot);

    await runCommand({
      command: 'pnpm',
      args: ['install', '--frozen-lockfile'],
      cwd: archiveRoot,
    });
    await prepareStagedFixture(fixtureRoot, runCommand);
    await runCommand({ command: 'node', args: [CLI_PATH, '--help'], cwd: archiveRoot });
    await runCommand({
      command: 'node',
      args: [CLI_PATH, 'validate', '--root', 'examples'],
      cwd: archiveRoot,
    });
    await runCommand({
      command: 'node',
      args: [CLI_PATH, 'review', 'create', '--staged', '--root', fixtureRoot, '--json'],
      cwd: archiveRoot,
    });

    let previewStarted = false;
    try {
      await runCommand({
        command: 'node',
        args: [CLI_PATH, 'preview', 'start', '--root', fixtureRoot, '--json'],
        cwd: archiveRoot,
      });
      previewStarted = true;
      await assertHealthyPreview(readRuntimeOrigin(fixtureRoot), fetch);
    } finally {
      if (previewStarted) {
        await runCommand({
          command: 'node',
          args: [CLI_PATH, 'preview', 'stop', '--root', fixtureRoot, '--json'],
          cwd: archiveRoot,
        });
      }
    }

    assertChecksumsUnchanged(archiveRoot, checksums);
  } finally {
    if (ownsTemporaryRoot) rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

const isMain =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runPluginArchiveSmoke()
    .then(() => {
      process.stdout.write('Plugin archive smoke: OK\n');
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
