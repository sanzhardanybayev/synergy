import { randomUUID } from 'node:crypto';
import {
  constants,
  closeSync,
  copyFileSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  unlinkSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dim, green, yellow } from 'kleur/colors';
import { PREVIEW_PORT, resolveProjectPaths } from './paths.js';
import {
  type AcquiredPreviewStartLock,
  type PreviewStartLockDependencies,
  acquirePreviewStartLock,
} from './preview-lock.js';
import {
  type PreviewChildHandle,
  type PreviewChildLaunch,
  type PreviewProcessTimerDependencies,
  type ReadyPreviewChild,
  detachReadyPreviewChild,
  spawnPreviewChild,
  terminateOwnedPreviewChild,
  waitForReadyPreviewChild,
} from './preview-process.js';
import {
  type PreviewHealth,
  type PreviewRuntimeState,
  deriveLoopbackOrigin,
  deriveProjectId,
  generateControlToken,
  readPreviewRuntime,
  removeOwnedPreviewRuntime,
  writePreviewRuntime,
} from './preview-runtime.js';
import {
  type PreviewHealthOutcome,
  type PreviewTransportDependencies,
  requestPreviewHealth,
  requestPreviewShutdown,
} from './preview-transport.js';

export type { PreviewChildHandle, PreviewChildLaunch } from './preview-process.js';

const require = createRequire(import.meta.url);
const START_TIMEOUT_MS = 10_000;
const START_CLEANUP_RESERVE_MS = 1_000;
const STOP_TIMEOUT_MS = 3_000;
const STOP_CLEANUP_RESERVE_MS = 100;
const STATUS_TIMEOUT_MS = 500;
const POLL_INTERVAL_MS = 25;
const LOCK_STALE_MS = START_TIMEOUT_MS;
const TERMINATION_GRACE_MS = 500;
const MAX_LOG_TAIL_BYTES = 4_096;

export interface PreviewStartOptions {
  root?: string;
  port?: number;
  background?: boolean;
}

export interface PreviewTimings {
  lockMs: number;
  launchMs: number;
  listenMs: number;
  healthMs: number;
  totalMs: number;
}

export interface PreviewStatus {
  running: boolean;
  pid: number | null;
  port: number | null;
  origin: string | null;
  projectId: string;
  instanceId: string | null;
  timings?: PreviewTimings;
}

export interface PreviewLifecycleDependencies
  extends PreviewTransportDependencies,
    PreviewProcessTimerDependencies,
    PreviewStartLockDependencies {
  canonicalizeRoot(root?: string): string;
  cleanupReserveMs: number;
  createAttemptId(): string;
  createControlToken(): string;
  createInstanceId(): string;
  lockStaleMs: number;
  pollIntervalMs: number;
  processKill(pid: number, signal: 0): boolean;
  removeRuntime(path: string, instanceId: string): boolean;
  spawnChild(launch: PreviewChildLaunch): PreviewChildHandle;
  startTimeoutMs: number;
  statusTimeoutMs: number;
  stopCleanupReserveMs: number;
  stopTimeoutMs: number;
  terminationGraceMs: number;
  writeOutput(text: string): void;
  writeRuntime(path: string, runtime: PreviewRuntimeState): void;
}

export interface PreviewLifecycle {
  start(options?: PreviewStartOptions): Promise<PreviewStatus>;
  status(root?: string): Promise<PreviewStatus>;
  stop(root?: string): Promise<boolean>;
}

const DEFAULT_DEPENDENCIES: PreviewLifecycleDependencies = {
  canonicalizeRoot: (root) => realpathSync(resolveProjectPaths(root).root),
  cleanupReserveMs: START_CLEANUP_RESERVE_MS,
  clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  copyFileExclusive: (source, destination) =>
    copyFileSync(source, destination, constants.COPYFILE_EXCL),
  createAttemptId: randomUUID,
  createControlToken: generateControlToken,
  createInstanceId: randomUUID,
  createQuarantineId: randomUUID,
  fetch: (input, init) => fetch(input, init),
  lockStaleMs: LOCK_STALE_MS,
  now: () => performance.now(),
  pollIntervalMs: POLL_INTERVAL_MS,
  processKill: (pid, signal) => process.kill(pid, signal),
  removeRuntime: removeOwnedPreviewRuntime,
  setTimer: (callback, milliseconds) => setTimeout(callback, milliseconds),
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  spawnChild: spawnPreviewChild,
  startTimeoutMs: START_TIMEOUT_MS,
  statusTimeoutMs: STATUS_TIMEOUT_MS,
  stopCleanupReserveMs: STOP_CLEANUP_RESERVE_MS,
  stopTimeoutMs: STOP_TIMEOUT_MS,
  terminationGraceMs: TERMINATION_GRACE_MS,
  wallNow: Date.now,
  writeOutput: (text) => process.stdout.write(text),
  writeRuntime: writePreviewRuntime,
};

function mergeDependencies(
  overrides: Partial<PreviewLifecycleDependencies>,
): PreviewLifecycleDependencies {
  return { ...DEFAULT_DEPENDENCIES, ...overrides };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasErrorCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function toolVersion(): string {
  const packageJson: unknown = require('../package.json');
  if (
    isRecord(packageJson) &&
    'version' in packageJson &&
    typeof packageJson.version === 'string'
  ) {
    return packageJson.version;
  }
  return 'unknown';
}

function healthMatchesRuntime(health: PreviewHealth, runtime: PreviewRuntimeState): boolean {
  return (
    health.protocolVersion === runtime.protocolVersion &&
    health.state === runtime.state &&
    health.instanceId === runtime.instanceId &&
    health.projectId === runtime.projectId &&
    health.pid === runtime.pid &&
    health.port === runtime.port
  );
}

function healthMatchesLaunch(
  health: PreviewHealth,
  launch: PreviewChildLaunch,
  ready: ReadyPreviewChild,
): boolean {
  return (
    health.protocolVersion === 1 &&
    health.state === 'ready' &&
    health.instanceId === launch.instanceId &&
    health.projectId === launch.projectId &&
    health.pid === ready.pid &&
    health.port === ready.port
  );
}

function stoppedStatus(projectId: string): PreviewStatus {
  return {
    running: false,
    pid: null,
    port: null,
    origin: null,
    projectId,
    instanceId: null,
  };
}

function runningStatus(runtime: PreviewRuntimeState, timings?: PreviewTimings): PreviewStatus {
  return {
    running: true,
    pid: runtime.pid,
    port: runtime.port,
    origin: deriveLoopbackOrigin(runtime.port),
    projectId: runtime.projectId,
    instanceId: runtime.instanceId,
    ...(timings === undefined ? {} : { timings }),
  };
}

function projectPaths(
  root: string | undefined,
  dependencies: PreviewLifecycleDependencies,
): ReturnType<typeof resolveProjectPaths> {
  return resolveProjectPaths(dependencies.canonicalizeRoot(root));
}

function migrateLegacyPid(pidFile: string, dependencies: PreviewLifecycleDependencies): void {
  if (!existsSync(pidFile)) return;
  let pid: number | null = null;
  try {
    const raw = readFileSync(pidFile, 'utf8').trim();
    const parsed = Number(raw);
    if (/^[1-9]\d*$/u.test(raw) && isPositiveInteger(parsed)) pid = parsed;
  } catch {
    return;
  }
  if (pid !== null) {
    try {
      dependencies.processKill(pid, 0);
      return;
    } catch (error) {
      if (!hasErrorCode(error, 'ESRCH')) return;
    }
  }
  try {
    unlinkSync(pidFile);
  } catch {
    // A concurrent migration may already have removed the stale record.
  }
}

function transportDependencies(
  dependencies: PreviewLifecycleDependencies,
): PreviewTransportDependencies {
  return {
    clearTimer: dependencies.clearTimer,
    fetch: dependencies.fetch,
    now: dependencies.now,
    setTimer: dependencies.setTimer,
  };
}

function processTimerDependencies(
  dependencies: PreviewLifecycleDependencies,
): PreviewProcessTimerDependencies {
  return {
    clearTimer: dependencies.clearTimer,
    now: dependencies.now,
    setTimer: dependencies.setTimer,
  };
}

function lockDependencies(
  dependencies: PreviewLifecycleDependencies,
): PreviewStartLockDependencies {
  return {
    copyFileExclusive: dependencies.copyFileExclusive,
    createQuarantineId: dependencies.createQuarantineId,
    now: dependencies.now,
    processKill: dependencies.processKill,
    wallNow: dependencies.wallNow,
    sleep: dependencies.sleep,
  };
}

async function readVerifiedStatusAtPaths(
  paths: ReturnType<typeof resolveProjectPaths>,
  timeoutMs: number,
  dependencies: PreviewLifecycleDependencies,
): Promise<PreviewStatus> {
  const projectId = deriveProjectId(paths.root);
  const runtime = readPreviewRuntime(paths.previewRuntimeFile);
  if (runtime === null) {
    migrateLegacyPid(paths.previewPidFile, dependencies);
    return stoppedStatus(projectId);
  }
  if (runtime.projectId !== projectId) return stoppedStatus(projectId);
  const outcome = await requestPreviewHealth(
    runtime.origin,
    timeoutMs,
    transportDependencies(dependencies),
  );
  if (outcome.kind !== 'healthy' || !healthMatchesRuntime(outcome.health, runtime)) {
    return stoppedStatus(projectId);
  }
  return runningStatus(runtime);
}

async function readVerifiedStatus(
  root: string | undefined,
  timeoutMs: number,
  dependencies: PreviewLifecycleDependencies,
): Promise<PreviewStatus> {
  return readVerifiedStatusAtPaths(projectPaths(root, dependencies), timeoutMs, dependencies);
}

async function pollLaunchHealth(
  launch: PreviewChildLaunch,
  ready: ReadyPreviewChild,
  deadline: number,
  dependencies: PreviewLifecycleDependencies,
): Promise<void> {
  const origin = deriveLoopbackOrigin(ready.port);
  while (dependencies.now() < deadline) {
    const outcome = await requestPreviewHealth(
      origin,
      deadline - dependencies.now(),
      transportDependencies(dependencies),
    );
    if (outcome.kind === 'healthy') {
      if (!healthMatchesLaunch(outcome.health, launch, ready)) {
        throw new Error('Preview health identity did not match the launched child');
      }
      return;
    }
    if (outcome.kind === 'malformed' || outcome.kind === 'http-error') {
      throw new Error('Preview health response was not a valid ready response');
    }
    const remainingMs = deadline - dependencies.now();
    if (remainingMs <= 0) break;
    await dependencies.sleep(Math.min(dependencies.pollIntervalMs, remainingMs));
  }
  throw new Error('Preview did not become ready within 10 seconds');
}

function readLogTail(path: string): string {
  if (!existsSync(path)) return '';
  let descriptor: number | null = null;
  try {
    descriptor = openSync(path, 'r');
    const size = fstatSync(descriptor).size;
    const length = Math.min(size, MAX_LOG_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    readSync(descriptor, buffer, 0, length, size - length);
    return buffer.toString('utf8').trim();
  } catch {
    return '';
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function withLogTail(error: unknown, logFile: string): Error {
  const message = error instanceof Error ? error.message : String(error);
  const tail = readLogTail(logFile);
  return new Error(tail.length === 0 ? message : `${message}\nPreview log tail:\n${tail}`);
}

function withCleanupFailures(primary: Error, cleanupFailures: Error[]): Error {
  if (cleanupFailures.length === 0) return primary;
  const details = cleanupFailures.map((failure) => failure.message).join('; ');
  return new Error(`${primary.message}\nPreview cleanup failed: ${details}`, {
    cause: new AggregateError([primary, ...cleanupFailures]),
  });
}

function buildRuntime(
  launch: PreviewChildLaunch,
  ready: ReadyPreviewChild,
  dependencies: PreviewLifecycleDependencies,
): PreviewRuntimeState {
  return {
    schemaVersion: 1,
    protocolVersion: 1,
    state: 'ready',
    instanceId: launch.instanceId,
    projectId: launch.projectId,
    pid: ready.pid,
    host: '127.0.0.1',
    port: ready.port,
    origin: deriveLoopbackOrigin(ready.port),
    preferredPort: launch.port,
    strictPort: launch.strictPort,
    startedAt: new Date(dependencies.wallNow()).toISOString(),
    controlToken: launch.controlToken,
    toolVersion: toolVersion(),
  };
}

async function startPreview(
  options: PreviewStartOptions,
  dependencies: PreviewLifecycleDependencies,
): Promise<PreviewStatus> {
  const invokedAt = dependencies.now();
  const totalDeadline = invokedAt + dependencies.startTimeoutMs;
  const cleanupReserveMs = Math.min(
    dependencies.cleanupReserveMs,
    Math.max(1, dependencies.startTimeoutMs / 5),
  );
  const workDeadline = totalDeadline - cleanupReserveMs;
  const paths = projectPaths(options.root, dependencies);
  mkdirSync(paths.synergyDir, { recursive: true });
  if (dependencies.now() >= workDeadline) {
    throw new Error('Preview did not become ready within 10 seconds');
  }

  const attemptId = dependencies.createAttemptId();
  let lock: AcquiredPreviewStartLock | null = null;
  let child: PreviewChildHandle | null = null;
  let instanceId: string | null = null;
  let hasPublishedRuntime = false;
  let shouldReleaseLock = true;
  try {
    lock = await acquirePreviewStartLock(
      {
        path: paths.previewLockFile,
        attemptId,
        deadline: workDeadline,
        staleMs: dependencies.lockStaleMs,
        pollIntervalMs: dependencies.pollIntervalMs,
      },
      lockDependencies(dependencies),
    );
    const statusTimeoutMs = Math.max(
      0,
      Math.min(dependencies.statusTimeoutMs, workDeadline - dependencies.now()),
    );
    const existing = await readVerifiedStatusAtPaths(paths, statusTimeoutMs, dependencies);
    if (existing.running) {
      dependencies.writeOutput(
        `${yellow('!')} Preview already running (pid ${existing.pid}) at ${existing.origin}\n`,
      );
      return existing;
    }
    if (dependencies.now() >= workDeadline) {
      throw new Error('Preview did not become ready within 10 seconds');
    }

    instanceId = dependencies.createInstanceId();
    const launch: PreviewChildLaunch = {
      root: paths.root,
      sessionsDir: paths.sessionsDir,
      logFile: paths.previewLogFile,
      projectId: deriveProjectId(paths.root),
      instanceId,
      controlToken: dependencies.createControlToken(),
      port: options.port ?? PREVIEW_PORT,
      strictPort: options.port !== undefined,
    };
    const launchStartedAt = dependencies.now();
    child = dependencies.spawnChild(launch);
    if (!isPositiveInteger(child.pid)) throw new Error('Failed to spawn preview child');
    if (!lock.updateOwnerPid(child.pid)) {
      throw new Error('Preview start lock owner update did not succeed');
    }
    const launchMs = dependencies.now() - launchStartedAt;
    const ready = await waitForReadyPreviewChild(
      child,
      launch,
      workDeadline - dependencies.now(),
      processTimerDependencies(dependencies),
    );
    const healthStartedAt = dependencies.now();
    await pollLaunchHealth(launch, ready, workDeadline, dependencies);
    const healthMs = dependencies.now() - healthStartedAt;
    if (dependencies.now() >= workDeadline) {
      throw new Error('Preview did not become ready within 10 seconds');
    }

    const runtime = buildRuntime(launch, ready, dependencies);
    dependencies.writeRuntime(paths.previewRuntimeFile, runtime);
    hasPublishedRuntime = true;
    if (dependencies.now() > workDeadline) {
      throw new Error('Preview did not become ready within 10 seconds');
    }
    const lockMs = lock.lockMs;
    detachReadyPreviewChild(child);
    shouldReleaseLock = false;
    if (!lock.release()) throw new Error('Preview start lock release did not succeed');
    lock = null;
    if (dependencies.now() > totalDeadline) {
      throw new Error('Preview did not become ready within 10 seconds');
    }
    const timings: PreviewTimings = {
      lockMs,
      launchMs,
      listenMs: ready.listenMs,
      healthMs,
      totalMs: dependencies.now() - invokedAt,
    };
    dependencies.writeOutput(
      `${green('✓')} Preview started (pid ${runtime.pid}) at ${dim(runtime.origin)}\n`,
    );
    dependencies.writeOutput(`  Log: ${dim(paths.previewLogFile)}\n`);
    child = null;
    return runningStatus(runtime, timings);
  } catch (error) {
    const failure = withLogTail(error, paths.previewLogFile);
    const cleanupFailures: Error[] = [];
    if (hasPublishedRuntime && instanceId !== null) {
      try {
        if (!dependencies.removeRuntime(paths.previewRuntimeFile, instanceId)) {
          cleanupFailures.push(new Error('runtime metadata removal did not succeed'));
        }
      } catch (cleanupError) {
        cleanupFailures.push(
          new Error(
            `runtime metadata removal failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
          ),
        );
      }
    }
    if (child !== null) {
      const didExit = await terminateOwnedPreviewChild(
        child,
        { deadline: totalDeadline, termGraceMs: dependencies.terminationGraceMs },
        processTimerDependencies(dependencies),
      );
      if (!didExit) {
        shouldReleaseLock = false;
      }
    }
    if (lock !== null && shouldReleaseLock) {
      shouldReleaseLock = false;
      try {
        if (!lock.release()) cleanupFailures.push(new Error('start lock release did not succeed'));
      } catch (releaseError) {
        cleanupFailures.push(
          new Error(
            `start lock release failed: ${releaseError instanceof Error ? releaseError.message : String(releaseError)}`,
          ),
        );
      }
    }
    throw withCleanupFailures(failure, cleanupFailures);
  } finally {
    if (lock !== null && shouldReleaseLock) lock.release();
  }
}

function isDefinitiveDisappearance(
  outcome: PreviewHealthOutcome,
  runtime: PreviewRuntimeState,
): boolean {
  return (
    outcome.kind === 'absent' ||
    (outcome.kind === 'healthy' && !healthMatchesRuntime(outcome.health, runtime))
  );
}

async function stopPreview(
  root: string | undefined,
  dependencies: PreviewLifecycleDependencies,
): Promise<boolean> {
  const invokedAt = dependencies.now();
  const totalDeadline = invokedAt + dependencies.stopTimeoutMs;
  const cleanupReserveMs = Math.min(
    dependencies.stopCleanupReserveMs,
    Math.max(1, dependencies.stopTimeoutMs / 5),
  );
  const workDeadline = totalDeadline - cleanupReserveMs;
  const paths = projectPaths(root, dependencies);
  let lock: AcquiredPreviewStartLock;
  try {
    lock = await acquirePreviewStartLock(
      {
        path: paths.previewLockFile,
        attemptId: dependencies.createAttemptId(),
        deadline: workDeadline,
        staleMs: dependencies.lockStaleMs,
        pollIntervalMs: dependencies.pollIntervalMs,
      },
      lockDependencies(dependencies),
    );
  } catch {
    return false;
  }
  try {
    const projectId = deriveProjectId(paths.root);
    const runtime = readPreviewRuntime(paths.previewRuntimeFile);
    if (runtime === null) {
      migrateLegacyPid(paths.previewPidFile, dependencies);
      dependencies.writeOutput(`${yellow('!')} No verified preview server recorded\n`);
      return false;
    }
    if (runtime.projectId !== projectId || dependencies.now() >= workDeadline) return false;

    const initial = await requestPreviewHealth(
      runtime.origin,
      Math.max(0, Math.min(dependencies.statusTimeoutMs, workDeadline - dependencies.now())),
      transportDependencies(dependencies),
    );
    if (
      initial.kind !== 'healthy' ||
      !healthMatchesRuntime(initial.health, runtime) ||
      dependencies.now() >= workDeadline
    ) {
      return false;
    }

    const shutdown = await requestPreviewShutdown(
      runtime.origin,
      runtime.instanceId,
      runtime.controlToken,
      workDeadline - dependencies.now(),
      transportDependencies(dependencies),
    );
    if (shutdown.kind !== 'accepted' || dependencies.now() >= workDeadline) return false;

    while (dependencies.now() < workDeadline) {
      const outcome = await requestPreviewHealth(
        runtime.origin,
        Math.max(0, Math.min(dependencies.statusTimeoutMs, workDeadline - dependencies.now())),
        transportDependencies(dependencies),
      );
      if (isDefinitiveDisappearance(outcome, runtime)) {
        const removed = dependencies.removeRuntime(paths.previewRuntimeFile, runtime.instanceId);
        if (!removed || dependencies.now() > totalDeadline) return false;
        dependencies.writeOutput(`${green('✓')} Preview stopped (pid ${runtime.pid})\n`);
        return true;
      }
      const remainingMs = workDeadline - dependencies.now();
      if (remainingMs <= 0) break;
      await dependencies.sleep(Math.min(dependencies.pollIntervalMs, remainingMs));
    }
    return false;
  } finally {
    lock.release();
  }
}

export function createPreviewLifecycle(
  dependencyOverrides: Partial<PreviewLifecycleDependencies> = {},
): PreviewLifecycle {
  const dependencies = mergeDependencies(dependencyOverrides);
  return {
    start: (options = {}) => startPreview(options, dependencies),
    status: (root) => readVerifiedStatus(root, dependencies.statusTimeoutMs, dependencies),
    stop: (root) => stopPreview(root, dependencies),
  };
}

const defaultLifecycle = createPreviewLifecycle();

export async function previewStatus(root?: string): Promise<PreviewStatus> {
  return defaultLifecycle.status(root);
}

export async function previewStart(options: PreviewStartOptions = {}): Promise<PreviewStatus> {
  return defaultLifecycle.start(options);
}

export async function previewStop(root?: string): Promise<boolean> {
  return defaultLifecycle.stop(root);
}

export function printStatus(status: PreviewStatus): void {
  if (status.running) {
    process.stdout.write(`${green('●')} running  pid ${status.pid}  ${status.origin}\n`);
  } else {
    process.stdout.write(`${dim('○')} stopped\n`);
  }
}
