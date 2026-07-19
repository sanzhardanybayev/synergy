import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REQUIRED_RUNTIME_ARTIFACTS, RUNTIME_OUTPUT_ROOTS } from './artifacts.js';

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

interface ArtifactSnapshot {
  checksums: Map<string, string>;
  files: string[];
}

interface RunningPreviewStatus {
  running: true;
  pid: number;
  port: number;
  origin: string;
  projectId: string;
  instanceId: string;
}

interface RuntimeMetadata extends RunningPreviewStatus {
  protocolVersion: 1;
  state: 'ready';
}

interface PreviewHealth {
  protocolVersion: 1;
  state: 'ready';
  instanceId: string;
  projectId: string;
  pid: number;
  port: number;
}

const CLI_PATH = 'packages/cli/dist/cli.js';
const RUNTIME_FILE = '.synergy/preview.runtime.json';
const COMMAND_DIAGNOSTIC_LIMIT = 4_096;

function boundedDiagnostic(value: unknown): string | null {
  const output =
    typeof value === 'string'
      ? value
      : value instanceof Uint8Array
        ? Buffer.from(value).toString('utf8')
        : null;
  if (output === null || output.length === 0) return null;
  if (output.length <= COMMAND_DIAGNOSTIC_LIMIT) return output.trimEnd();
  const marker = '\n[truncated]\n';
  const retainedLength = COMMAND_DIAGNOSTIC_LIMIT - marker.length;
  const headLength = Math.ceil(retainedLength / 2);
  const tailLength = Math.floor(retainedLength / 2);
  return `${output.slice(0, headLength).trimEnd()}${marker}${output.slice(-tailLength).trimStart()}`;
}

function commandFailureStatus(error: unknown): string {
  if (!isRecord(error)) return 'unknown';
  return typeof error.status === 'number' ? String(error.status) : 'unknown';
}

export function runDefaultSmokeCommand(invocation: SmokeCommand): SmokeCommandResult {
  try {
    return {
      stdout: execFileSync(invocation.command, invocation.args, {
        cwd: invocation.cwd,
        encoding: 'utf8',
        env: { ...process.env, CI: '1' },
        maxBuffer: 10 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    };
  } catch (error) {
    const command = boundedDiagnostic(
      [invocation.command, ...invocation.args].map((value) => JSON.stringify(value)).join(' '),
    );
    const stdout = isRecord(error) ? boundedDiagnostic(error.stdout) : null;
    const stderr = isRecord(error) ? boundedDiagnostic(error.stderr) : null;
    const reason = boundedDiagnostic(error instanceof Error ? error.message : String(error));
    const diagnostics = [
      `Archive smoke command failed (exit ${commandFailureStatus(error)}): ${command ?? invocation.command}`,
      stdout === null ? null : `stdout:\n${stdout}`,
      stderr === null ? null : `stderr:\n${stderr}`,
      stdout === null && stderr === null && reason !== null ? `reason:\n${reason}` : null,
    ].filter((value): value is string => value !== null);
    throw new Error(diagnostics.join('\n'), { cause: error });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isPort(value: unknown): value is number {
  return isPositiveInteger(value) && value <= 65_535;
}

function loopbackOrigin(port: number): string {
  return `http://127.0.0.1:${port}`;
}

function assertResolvedInsideArchive(
  archiveRoot: string,
  resolvedPath: string,
  artifact: string,
): void {
  const fromRoot = relative(archiveRoot, resolvedPath);
  if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error(`Runtime output resolves outside archive: ${artifact}`);
  }
}

function enumerateRuntimeFiles(archiveRoot: string): string[] {
  const resolvedArchiveRoot = realpathSync(archiveRoot);
  const files: string[] = [];

  function visit(relativePath: string): void {
    const absolutePath = resolve(archiveRoot, relativePath);
    const metadata = lstatSync(absolutePath);
    if (metadata.isSymbolicLink()) {
      throw new Error(`Runtime output contains a symbolic link: ${relativePath}`);
    }

    assertResolvedInsideArchive(resolvedArchiveRoot, realpathSync(absolutePath), relativePath);
    if (metadata.isDirectory()) {
      for (const entry of readdirSync(absolutePath)) visit(`${relativePath}/${entry}`);
      return;
    }
    if (!metadata.isFile()) {
      throw new Error(`Runtime output is not a regular file: ${relativePath}`);
    }
    files.push(relativePath);
  }

  for (const outputRoot of RUNTIME_OUTPUT_ROOTS) {
    const absoluteRoot = resolve(archiveRoot, outputRoot);
    if (!existsSync(absoluteRoot))
      throw new Error(`Archive is missing runtime root: ${outputRoot}`);
    visit(outputRoot);
  }
  return files.sort();
}

function captureArtifactSnapshot(archiveRoot: string): ArtifactSnapshot {
  const files = enumerateRuntimeFiles(archiveRoot);
  const fileSet = new Set(files);
  for (const artifact of REQUIRED_RUNTIME_ARTIFACTS) {
    if (!fileSet.has(artifact)) {
      throw new Error(`Archive is missing required runtime artifact: ${artifact}`);
    }
  }

  return {
    files,
    checksums: new Map(
      files.map((artifact) => [
        artifact,
        createHash('sha256')
          .update(readFileSync(join(archiveRoot, artifact)))
          .digest('hex'),
      ]),
    ),
  };
}

function assertArtifactSnapshot(archiveRoot: string, before: ArtifactSnapshot): void {
  const files = enumerateRuntimeFiles(archiveRoot);
  if (
    files.length !== before.files.length ||
    files.some((file, index) => file !== before.files[index])
  ) {
    const beforeSet = new Set(before.files);
    const afterSet = new Set(files);
    const changedPath =
      files.find((file) => !beforeSet.has(file)) ??
      before.files.find((file) => !afterSet.has(file));
    throw new Error(
      `Runtime artifact tree changed during archive smoke: ${changedPath ?? 'unknown'}`,
    );
  }

  for (const artifact of files) {
    const actual = createHash('sha256')
      .update(readFileSync(join(archiveRoot, artifact)))
      .digest('hex');
    if (actual !== before.checksums.get(artifact)) {
      throw new Error(`Runtime artifact changed during archive smoke: ${artifact}`);
    }
  }
}

function parseJson(stdout: string, label: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(`${label} returned malformed JSON`);
  }
}

function parseReviewReference(stdout: string): string {
  const payload = parseJson(stdout, 'Staged review creation');
  if (!isRecord(payload) || !isNonemptyString(payload.reference)) {
    throw new Error('Staged review creation did not return a reference');
  }
  return payload.reference;
}

function parseRunningStatus(stdout: string): RunningPreviewStatus {
  const payload = parseJson(stdout, 'Preview status');
  if (
    !isRecord(payload) ||
    payload.running !== true ||
    !isPositiveInteger(payload.pid) ||
    !isPort(payload.port) ||
    !isNonemptyString(payload.origin) ||
    payload.origin !== loopbackOrigin(payload.port) ||
    !isNonemptyString(payload.projectId) ||
    !isNonemptyString(payload.instanceId)
  ) {
    throw new Error('Preview status response was malformed');
  }
  return {
    running: true,
    pid: payload.pid,
    port: payload.port,
    origin: payload.origin,
    projectId: payload.projectId,
    instanceId: payload.instanceId,
  };
}

function assertStoppedStatus(stdout: string, expectedProjectId: string | null): void {
  const payload = parseJson(stdout, 'Post-stop preview status');
  if (isRecord(payload) && payload.running === true) {
    throw new Error('Preview remained running after stop');
  }
  if (
    !isRecord(payload) ||
    payload.running !== false ||
    payload.pid !== null ||
    payload.port !== null ||
    payload.origin !== null ||
    payload.instanceId !== null ||
    !isNonemptyString(payload.projectId) ||
    (expectedProjectId !== null && payload.projectId !== expectedProjectId)
  ) {
    throw new Error('Post-stop preview status was malformed');
  }
}

function readRuntimeMetadata(fixtureRoot: string): RuntimeMetadata {
  const payload = parseJson(
    readFileSync(join(fixtureRoot, RUNTIME_FILE), 'utf8'),
    'Preview runtime',
  );
  if (
    !isRecord(payload) ||
    payload.schemaVersion !== 1 ||
    payload.protocolVersion !== 1 ||
    payload.state !== 'ready' ||
    !isNonemptyString(payload.instanceId) ||
    !isNonemptyString(payload.projectId) ||
    !isPositiveInteger(payload.pid) ||
    payload.host !== '127.0.0.1' ||
    !isPort(payload.port) ||
    payload.origin !== loopbackOrigin(payload.port) ||
    !isPort(payload.preferredPort) ||
    typeof payload.strictPort !== 'boolean' ||
    !isNonemptyString(payload.startedAt) ||
    !isNonemptyString(payload.controlToken) ||
    !isNonemptyString(payload.toolVersion)
  ) {
    throw new Error('Preview runtime metadata was malformed');
  }
  return {
    running: true,
    protocolVersion: 1,
    state: 'ready',
    instanceId: payload.instanceId,
    projectId: payload.projectId,
    pid: payload.pid,
    port: payload.port,
    origin: payload.origin,
  };
}

function assertStatusMatchesRuntime(status: RunningPreviewStatus, runtime: RuntimeMetadata): void {
  if (
    status.instanceId !== runtime.instanceId ||
    status.projectId !== runtime.projectId ||
    status.pid !== runtime.pid ||
    status.port !== runtime.port ||
    status.origin !== runtime.origin
  ) {
    throw new Error('Preview status identity did not match runtime metadata');
  }
}

function parseHealth(value: unknown): PreviewHealth {
  if (
    !isRecord(value) ||
    value.protocolVersion !== 1 ||
    value.state !== 'ready' ||
    !isNonemptyString(value.instanceId) ||
    !isNonemptyString(value.projectId) ||
    !isPositiveInteger(value.pid) ||
    !isPort(value.port)
  ) {
    throw new Error('Preview health response was malformed');
  }
  return {
    protocolVersion: 1,
    state: 'ready',
    instanceId: value.instanceId,
    projectId: value.projectId,
    pid: value.pid,
    port: value.port,
  };
}

async function assertHealthyPreview(
  status: RunningPreviewStatus,
  runtime: RuntimeMetadata,
  fetch: typeof globalThis.fetch,
): Promise<void> {
  const response = await fetch(new URL('/api/runtime/health', status.origin));
  if (!response.ok) throw new Error(`Preview health check failed with HTTP ${response.status}`);
  const health = parseHealth(await response.json());
  if (
    health.protocolVersion !== runtime.protocolVersion ||
    health.state !== runtime.state ||
    health.instanceId !== status.instanceId ||
    health.instanceId !== runtime.instanceId ||
    health.projectId !== status.projectId ||
    health.projectId !== runtime.projectId ||
    health.pid !== status.pid ||
    health.pid !== runtime.pid ||
    health.port !== status.port ||
    health.port !== runtime.port
  ) {
    throw new Error('Preview health identity did not match runtime status');
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

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function combineFailures(primary: Error | null, additional: Error): Error {
  if (primary === null) return additional;
  return new AggregateError(
    [primary, additional],
    `${primary.message}; additionally: ${additional.message}`,
  );
}

async function provePreviewStopped(options: {
  archiveRoot: string;
  expectedProjectId: string | null;
  fixtureRoot: string;
  runCommand: SmokeCommandRunner;
  temporaryRoot: string;
}): Promise<Error | null> {
  let failure: Error | null = null;
  try {
    await options.runCommand({
      command: 'node',
      args: [CLI_PATH, 'preview', 'stop', '--root', options.fixtureRoot],
      cwd: options.archiveRoot,
    });
  } catch (error) {
    failure = asError(error);
  }

  try {
    const result = await options.runCommand({
      command: 'node',
      args: [CLI_PATH, 'preview', 'status', '--root', options.fixtureRoot, '--json'],
      cwd: options.archiveRoot,
    });
    assertStoppedStatus(result.stdout, options.expectedProjectId);
  } catch (error) {
    failure = combineFailures(failure, asError(error));
  }

  if (failure === null) return null;
  return new Error(
    `Unable to prove preview cleanup; preserved ${options.temporaryRoot}: ${failure.message}`,
    { cause: failure },
  );
}

export async function runPluginArchiveSmoke(
  options: PluginArchiveSmokeOptions = {},
): Promise<void> {
  const repositoryRoot = resolve(options.repositoryRoot ?? process.cwd());
  const ownsTemporaryRoot = options.temporaryRoot === undefined;
  const temporaryRoot =
    options.temporaryRoot ?? mkdtempSync(join(tmpdir(), 'synergy-plugin-archive-'));
  const runCommand = options.runCommand ?? runDefaultSmokeCommand;
  const fetch = options.fetch ?? globalThis.fetch;
  const archiveTar = join(temporaryRoot, 'plugin.tar');
  const archiveRoot = join(temporaryRoot, 'archive');
  const fixtureRoot = join(temporaryRoot, 'consumer');
  let preserveTemporaryRoot = false;

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

    const snapshot = captureArtifactSnapshot(archiveRoot);
    let failure: Error | null = null;
    let previewStartAttempted = false;
    let expectedProjectId: string | null = null;

    try {
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
      const review = await runCommand({
        command: 'node',
        args: [CLI_PATH, 'review', 'create', '--staged', '--root', fixtureRoot, '--json'],
        cwd: archiveRoot,
      });
      parseReviewReference(review.stdout);

      previewStartAttempted = true;
      await runCommand({
        command: 'node',
        args: [CLI_PATH, 'preview', 'start', '--root', fixtureRoot],
        cwd: archiveRoot,
      });
      const statusResult = await runCommand({
        command: 'node',
        args: [CLI_PATH, 'preview', 'status', '--root', fixtureRoot, '--json'],
        cwd: archiveRoot,
      });
      const status = parseRunningStatus(statusResult.stdout);
      expectedProjectId = status.projectId;
      const runtime = readRuntimeMetadata(fixtureRoot);
      assertStatusMatchesRuntime(status, runtime);
      await assertHealthyPreview(status, runtime, fetch);
    } catch (error) {
      failure = asError(error);
    } finally {
      if (previewStartAttempted) {
        const cleanupFailure = await provePreviewStopped({
          archiveRoot,
          expectedProjectId,
          fixtureRoot,
          runCommand,
          temporaryRoot,
        });
        if (cleanupFailure !== null) {
          preserveTemporaryRoot = true;
          failure = combineFailures(failure, cleanupFailure);
        }
      }
    }

    try {
      assertArtifactSnapshot(archiveRoot, snapshot);
    } catch (error) {
      failure = combineFailures(failure, asError(error));
    }

    if (failure !== null) throw failure;
  } finally {
    if (ownsTemporaryRoot && !preserveTemporaryRoot) {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
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
