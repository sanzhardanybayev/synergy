import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dim, green, yellow } from 'kleur/colors';
import { PREVIEW_PORT, resolveProjectPaths } from './paths.js';
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

const require = createRequire(import.meta.url);
const START_TIMEOUT_MS = 10_000;
const STATUS_TIMEOUT_MS = 500;
const STOP_TIMEOUT_MS = 3_000;
const POLL_INTERVAL_MS = 25;
const LOCK_STALE_MS = START_TIMEOUT_MS;
const MAX_LOG_TAIL_BYTES = 4_096;

type PreviewChildMessage =
  | { type: 'ready'; instanceId: string; pid: number; port: number; listenMs: number }
  | { type: 'failed'; instanceId: string; phase: string; message: string };

interface StartLockRecord {
  attemptId: string;
  pid: number;
  createdAt: string;
}

interface AcquiredStartLock {
  lockMs: number;
  release(): void;
}

interface ReadyChild {
  pid: number;
  port: number;
  listenMs: number;
}

interface HealthResult {
  health: PreviewHealth | null;
  reachable: boolean;
}

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

export interface PreviewChildLaunch {
  root: string;
  sessionsDir: string;
  logFile: string;
  projectId: string;
  instanceId: string;
  controlToken: string;
  port: number;
  strictPort: boolean;
}

export interface PreviewChildHandle {
  readonly pid?: number;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  removeListener(event: string, listener: (...args: unknown[]) => void): unknown;
  kill(signal: NodeJS.Signals): boolean;
  disconnect?(): void;
  unref(): void;
}

export interface PreviewLifecycleDependencies {
  createAttemptId(): string;
  createInstanceId(): string;
  createControlToken(): string;
  clearTimer(timer: unknown): void;
  fetch(input: string | URL, init?: RequestInit): Promise<Response>;
  now(): number;
  processKill(pid: number, signal: 0): boolean;
  setTimer(callback: () => void, milliseconds: number): unknown;
  sleep(milliseconds: number): Promise<void>;
  spawnChild(launch: PreviewChildLaunch): PreviewChildHandle;
  writeOutput(text: string): void;
  lockStaleMs: number;
  pollIntervalMs: number;
  startTimeoutMs: number;
  statusTimeoutMs: number;
  stopTimeoutMs: number;
}

export interface PreviewLifecycle {
  start(options?: PreviewStartOptions): Promise<PreviewStatus>;
  status(root?: string): Promise<PreviewStatus>;
  stop(root?: string): Promise<boolean>;
}

function toolVersion(): string {
  const packageJson: unknown = require('../package.json');
  if (
    typeof packageJson === 'object' &&
    packageJson !== null &&
    'version' in packageJson &&
    typeof packageJson.version === 'string'
  ) {
    return packageJson.version;
  }
  return 'unknown';
}

function resolvePreviewChildEntry(): string {
  return fileURLToPath(new URL('./preview-child.js', import.meta.url));
}

function spawnPreviewChild(launch: PreviewChildLaunch): PreviewChildHandle {
  const logDescriptor = openSync(launch.logFile, 'a');
  try {
    return spawn(process.execPath, [resolvePreviewChildEntry()], {
      cwd: launch.root,
      env: {
        ...process.env,
        SYNERGY_PROJECT_ROOT: launch.root,
        SYNERGY_SESSIONS_DIR: launch.sessionsDir,
        SYNERGY_PROJECT_ID: launch.projectId,
        SYNERGY_INSTANCE_ID: launch.instanceId,
        SYNERGY_CONTROL_TOKEN: launch.controlToken,
        SYNERGY_PORT: String(launch.port),
        SYNERGY_STRICT_PORT: String(launch.strictPort),
      },
      detached: true,
      stdio: ['ignore', logDescriptor, logDescriptor, 'ipc'],
    });
  } finally {
    closeSync(logDescriptor);
  }
}

const DEFAULT_DEPENDENCIES: PreviewLifecycleDependencies = {
  createAttemptId: randomUUID,
  createInstanceId: randomUUID,
  createControlToken: generateControlToken,
  clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  fetch: (input, init) => fetch(input, init),
  now: () => performance.now(),
  processKill: (pid, signal) => process.kill(pid, signal),
  setTimer: (callback, milliseconds) => setTimeout(callback, milliseconds),
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  spawnChild: spawnPreviewChild,
  writeOutput: (text) => process.stdout.write(text),
  lockStaleMs: LOCK_STALE_MS,
  pollIntervalMs: POLL_INTERVAL_MS,
  startTimeoutMs: START_TIMEOUT_MS,
  statusTimeoutMs: STATUS_TIMEOUT_MS,
  stopTimeoutMs: STOP_TIMEOUT_MS,
};

function mergeDependencies(
  dependencies: Partial<PreviewLifecycleDependencies>,
): PreviewLifecycleDependencies {
  return { ...DEFAULT_DEPENDENCIES, ...dependencies };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65_535;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function parseChildMessage(value: unknown): PreviewChildMessage | null {
  if (!isRecord(value) || typeof value.type !== 'string') return null;
  if (value.type === 'ready') {
    if (
      typeof value.instanceId !== 'string' ||
      !isPositiveInteger(value.pid) ||
      !isPort(value.port) ||
      typeof value.listenMs !== 'number' ||
      !Number.isFinite(value.listenMs) ||
      value.listenMs < 0
    ) {
      return null;
    }
    return {
      type: 'ready',
      instanceId: value.instanceId,
      pid: value.pid,
      port: value.port,
      listenMs: value.listenMs,
    };
  }
  if (
    value.type === 'failed' &&
    typeof value.instanceId === 'string' &&
    typeof value.phase === 'string' &&
    typeof value.message === 'string'
  ) {
    return {
      type: 'failed',
      instanceId: value.instanceId,
      phase: value.phase,
      message: value.message,
    };
  }
  return null;
}

function parseHealth(value: unknown): PreviewHealth | null {
  if (!isRecord(value)) return null;
  const expectedKeys = ['protocolVersion', 'state', 'instanceId', 'projectId', 'pid', 'port'];
  if (
    Object.keys(value).length !== expectedKeys.length ||
    expectedKeys.some((key) => !(key in value)) ||
    value.protocolVersion !== 1 ||
    value.state !== 'ready' ||
    typeof value.instanceId !== 'string' ||
    value.instanceId.length === 0 ||
    typeof value.projectId !== 'string' ||
    value.projectId.length === 0 ||
    !isPositiveInteger(value.pid) ||
    !isPort(value.port)
  ) {
    return null;
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
  ready: ReadyChild,
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

function canonicalProjectPaths(root?: string): ReturnType<typeof resolveProjectPaths> {
  const unresolved = resolveProjectPaths(root);
  return resolveProjectPaths(realpathSync(unresolved.root));
}

function hasErrorCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

function readLockRecord(path: string): StartLockRecord | null {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (
      !isRecord(value) ||
      typeof value.attemptId !== 'string' ||
      !isPositiveInteger(value.pid) ||
      typeof value.createdAt !== 'string'
    ) {
      return null;
    }
    return { attemptId: value.attemptId, pid: value.pid, createdAt: value.createdAt };
  } catch {
    return null;
  }
}

function removeLockIfOwned(path: string, attemptId: string): void {
  if (readLockRecord(path)?.attemptId !== attemptId) return;
  try {
    unlinkSync(path);
  } catch {
    // Another actor may have already recovered the lock after its ownership changed.
  }
}

function recoverStaleLock(path: string, dependencies: PreviewLifecycleDependencies): boolean {
  try {
    const ageMs = Date.now() - statSync(path).mtimeMs;
    if (ageMs < dependencies.lockStaleMs) return false;
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

async function acquireStartLock(
  path: string,
  attemptId: string,
  startedAt: number,
  deadline: number,
  dependencies: PreviewLifecycleDependencies,
): Promise<AcquiredStartLock> {
  while (dependencies.now() < deadline) {
    try {
      const descriptor = openSync(path, 'wx', 0o600);
      try {
        const record: StartLockRecord = {
          attemptId,
          pid: process.pid,
          createdAt: new Date().toISOString(),
        };
        writeFileSync(descriptor, `${JSON.stringify(record)}\n`);
      } finally {
        closeSync(descriptor);
      }
      return {
        lockMs: dependencies.now() - startedAt,
        release: () => removeLockIfOwned(path, attemptId),
      };
    } catch (error) {
      if (!hasErrorCode(error, 'EEXIST')) throw error;
      if (recoverStaleLock(path, dependencies)) continue;
      const remainingMs = deadline - dependencies.now();
      if (remainingMs <= 0) break;
      await dependencies.sleep(Math.min(dependencies.pollIntervalMs, remainingMs));
    }
  }
  throw new Error(
    'Preview did not become ready within 10 seconds while waiting for its start lock',
  );
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
    } catch {
      // Signal 0 proved this legacy PID is stale; removing its file is safe.
    }
  }
  try {
    unlinkSync(pidFile);
  } catch {
    // A concurrent migration may already have removed it.
  }
}

async function fetchHealth(
  origin: string,
  timeoutMs: number,
  dependencies: PreviewLifecycleDependencies,
): Promise<HealthResult> {
  if (timeoutMs <= 0) return { health: null, reachable: false };
  try {
    const response = await dependencies.fetch(`${origin}/api/runtime/health`, {
      method: 'GET',
      signal: AbortSignal.timeout(Math.max(1, Math.ceil(timeoutMs))),
    });
    if (!response.ok) return { health: null, reachable: false };
    return { health: parseHealth(await response.json()), reachable: true };
  } catch {
    return { health: null, reachable: false };
  }
}

function waitForReadyChild(
  child: PreviewChildHandle,
  launch: PreviewChildLaunch,
  remainingMs: number,
  dependencies: PreviewLifecycleDependencies,
): Promise<ReadyChild> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: unknown = null;
    const finish = (result: ReadyChild | Error): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) dependencies.clearTimer(timer);
      child.removeListener('message', onMessage);
      child.removeListener('error', onError);
      child.removeListener('exit', onExit);
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
    const onMessage = (value: unknown): void => {
      const message = parseChildMessage(value);
      if (message === null) {
        finish(new Error('Preview child sent an invalid readiness message'));
        return;
      }
      if (message.instanceId !== launch.instanceId) {
        finish(new Error('Preview child readiness identity did not match the launch attempt'));
        return;
      }
      if (message.type === 'failed') {
        finish(new Error(`Preview child failed during ${message.phase}: ${message.message}`));
        return;
      }
      if (message.pid !== child.pid) {
        finish(new Error('Preview child readiness identity did not match its process'));
        return;
      }
      finish({ pid: message.pid, port: message.port, listenMs: message.listenMs });
    };
    const onError = (error: unknown): void => {
      finish(
        new Error(
          `Preview child failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    };
    const onExit = (code: unknown, signal: unknown): void => {
      finish(
        new Error(
          `Preview child exited before readiness (code ${String(code)}, signal ${String(signal)})`,
        ),
      );
    };
    child.on('message', onMessage);
    child.on('error', onError);
    child.on('exit', onExit);
    timer = dependencies.setTimer(
      () => {
        finish(new Error('Preview did not become ready within 10 seconds'));
      },
      Math.max(0, remainingMs),
    );
  });
}

async function pollLaunchHealth(
  launch: PreviewChildLaunch,
  ready: ReadyChild,
  deadline: number,
  dependencies: PreviewLifecycleDependencies,
): Promise<void> {
  const origin = deriveLoopbackOrigin(ready.port);
  while (dependencies.now() < deadline) {
    const remainingMs = deadline - dependencies.now();
    const result = await fetchHealth(origin, remainingMs, dependencies);
    if (result.health !== null) {
      if (!healthMatchesLaunch(result.health, launch, ready)) {
        throw new Error('Preview health identity did not match the launched child');
      }
      return;
    }
    if (result.reachable) throw new Error('Preview health response was malformed');
    const afterRequestRemainingMs = deadline - dependencies.now();
    if (afterRequestRemainingMs <= 0) break;
    await dependencies.sleep(Math.min(dependencies.pollIntervalMs, afterRequestRemainingMs));
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

function terminateOwnedChild(child: PreviewChildHandle | null): void {
  if (child === null) return;
  try {
    child.kill('SIGTERM');
  } catch {
    // The owned child may already have exited.
  }
  try {
    child.disconnect?.();
  } catch {
    // The IPC channel may already be closed.
  }
  child.unref();
}

async function verifiedStatus(
  root: string | undefined,
  dependencies: PreviewLifecycleDependencies,
): Promise<PreviewStatus> {
  const paths = canonicalProjectPaths(root);
  const projectId = deriveProjectId(paths.root);
  const runtime = readPreviewRuntime(paths.previewRuntimeFile);
  if (runtime === null) {
    migrateLegacyPid(paths.previewPidFile, dependencies);
    return stoppedStatus(projectId);
  }
  if (runtime.projectId !== projectId) return stoppedStatus(projectId);
  const result = await fetchHealth(runtime.origin, dependencies.statusTimeoutMs, dependencies);
  if (result.health === null || !healthMatchesRuntime(result.health, runtime)) {
    return stoppedStatus(projectId);
  }
  return runningStatus(runtime);
}

async function startPreview(
  options: PreviewStartOptions,
  dependencies: PreviewLifecycleDependencies,
): Promise<PreviewStatus> {
  const startedAt = dependencies.now();
  const deadline = startedAt + dependencies.startTimeoutMs;
  const paths = canonicalProjectPaths(options.root);
  mkdirSync(paths.synergyDir, { recursive: true });
  const attemptId = dependencies.createAttemptId();
  const lock = await acquireStartLock(
    paths.previewLockFile,
    attemptId,
    startedAt,
    deadline,
    dependencies,
  );
  let child: PreviewChildHandle | null = null;
  let instanceId: string | null = null;
  let hasPublishedRuntime = false;
  try {
    const existing = await verifiedStatus(paths.root, dependencies);
    if (existing.running) {
      dependencies.writeOutput(
        `${yellow('!')} Preview already running (pid ${existing.pid}) at ${existing.origin}\n`,
      );
      return existing;
    }
    if (dependencies.now() >= deadline) {
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
    const launchMs = dependencies.now() - launchStartedAt;
    const ready = await waitForReadyChild(
      child,
      launch,
      deadline - dependencies.now(),
      dependencies,
    );
    const healthStartedAt = dependencies.now();
    await pollLaunchHealth(launch, ready, deadline, dependencies);
    const healthMs = dependencies.now() - healthStartedAt;
    const totalMs = dependencies.now() - startedAt;
    const timings: PreviewTimings = {
      lockMs: lock.lockMs,
      launchMs,
      listenMs: ready.listenMs,
      healthMs,
      totalMs,
    };
    const runtime: PreviewRuntimeState = {
      schemaVersion: 1,
      protocolVersion: 1,
      state: 'ready',
      instanceId,
      projectId: launch.projectId,
      pid: ready.pid,
      host: '127.0.0.1',
      port: ready.port,
      origin: deriveLoopbackOrigin(ready.port),
      preferredPort: launch.port,
      strictPort: launch.strictPort,
      startedAt: new Date().toISOString(),
      controlToken: launch.controlToken,
      toolVersion: toolVersion(),
    };
    writePreviewRuntime(paths.previewRuntimeFile, runtime);
    hasPublishedRuntime = true;
    child.disconnect?.();
    child.unref();
    child = null;
    dependencies.writeOutput(
      `${green('✓')} Preview started (pid ${runtime.pid}) at ${dim(runtime.origin)}\n`,
    );
    dependencies.writeOutput(`  Log: ${dim(paths.previewLogFile)}\n`);
    return runningStatus(runtime, timings);
  } catch (error) {
    if (hasPublishedRuntime && instanceId !== null) {
      removeOwnedPreviewRuntime(paths.previewRuntimeFile, instanceId);
    }
    terminateOwnedChild(child);
    throw withLogTail(error, paths.previewLogFile);
  } finally {
    lock.release();
  }
}

async function stopPreview(
  root: string | undefined,
  dependencies: PreviewLifecycleDependencies,
): Promise<boolean> {
  const paths = canonicalProjectPaths(root);
  const projectId = deriveProjectId(paths.root);
  const runtime = readPreviewRuntime(paths.previewRuntimeFile);
  if (runtime === null) {
    migrateLegacyPid(paths.previewPidFile, dependencies);
    dependencies.writeOutput(`${yellow('!')} No verified preview server recorded\n`);
    return false;
  }
  if (runtime.projectId !== projectId) return false;
  const initial = await fetchHealth(runtime.origin, dependencies.statusTimeoutMs, dependencies);
  if (initial.health === null || !healthMatchesRuntime(initial.health, runtime)) return false;

  let response: Response;
  try {
    response = await dependencies.fetch(`${runtime.origin}/api/runtime/shutdown`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${runtime.controlToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ instanceId: runtime.instanceId }),
      signal: AbortSignal.timeout(dependencies.statusTimeoutMs),
    });
  } catch {
    return false;
  }
  if (!response.ok) return false;

  const deadline = dependencies.now() + dependencies.stopTimeoutMs;
  while (dependencies.now() < deadline) {
    const remainingMs = deadline - dependencies.now();
    const result = await fetchHealth(runtime.origin, remainingMs, dependencies);
    if (result.health === null && !result.reachable) {
      removeOwnedPreviewRuntime(paths.previewRuntimeFile, runtime.instanceId);
      dependencies.writeOutput(`${green('✓')} Preview stopped (pid ${runtime.pid})\n`);
      return true;
    }
    if (result.health !== null && !healthMatchesRuntime(result.health, runtime)) {
      removeOwnedPreviewRuntime(paths.previewRuntimeFile, runtime.instanceId);
      dependencies.writeOutput(`${green('✓')} Preview stopped (pid ${runtime.pid})\n`);
      return true;
    }
    const afterRequestRemainingMs = deadline - dependencies.now();
    if (afterRequestRemainingMs <= 0) break;
    await dependencies.sleep(Math.min(dependencies.pollIntervalMs, afterRequestRemainingMs));
  }
  return false;
}

export function createPreviewLifecycle(
  dependencyOverrides: Partial<PreviewLifecycleDependencies> = {},
): PreviewLifecycle {
  const dependencies = mergeDependencies(dependencyOverrides);
  return {
    start: (options = {}) => startPreview(options, dependencies),
    status: (root) => verifiedStatus(root, dependencies),
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
