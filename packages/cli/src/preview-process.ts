import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

type PreviewChildMessage =
  | { type: 'ready'; instanceId: string; pid: number; port: number; listenMs: number }
  | { type: 'failed'; instanceId: string; phase: string; message: string }
  | { type: 'committed'; instanceId: string };

interface PreviewParentMessage {
  type: 'commit';
  instanceId: string;
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
  readonly exitCode?: number | null;
  readonly signalCode?: NodeJS.Signals | null;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  removeListener(event: string, listener: (...args: unknown[]) => void): unknown;
  kill(signal: NodeJS.Signals): boolean;
  send?(message: PreviewParentMessage, callback: (error: Error | null) => void): boolean;
  disconnect?(): void;
  unref(): void;
}

export interface ReadyPreviewChild {
  pid: number;
  port: number;
  listenMs: number;
}

export interface PreviewProcessTimerDependencies {
  clearTimer(timer: unknown): void;
  now(): number;
  setTimer(callback: () => void, milliseconds: number): unknown;
}

export interface PreviewChildTerminationOptions {
  deadline: number;
  termGraceMs: number;
}

const DEFAULT_TIMER_DEPENDENCIES: PreviewProcessTimerDependencies = {
  clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  now: () => performance.now(),
  setTimer: (callback, milliseconds) => setTimeout(callback, milliseconds),
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isPort(value: unknown): value is number {
  return isPositiveInteger(value) && value <= 65_535;
}

function parseChildMessage(value: unknown): PreviewChildMessage | null {
  if (!isRecord(value) || typeof value.type !== 'string') return null;
  if (
    value.type === 'ready' &&
    typeof value.instanceId === 'string' &&
    isPositiveInteger(value.pid) &&
    isPort(value.port) &&
    typeof value.listenMs === 'number' &&
    Number.isFinite(value.listenMs) &&
    value.listenMs >= 0
  ) {
    return {
      type: 'ready',
      instanceId: value.instanceId,
      pid: value.pid,
      port: value.port,
      listenMs: value.listenMs,
    };
  }
  if (value.type === 'committed' && typeof value.instanceId === 'string') {
    return { type: 'committed', instanceId: value.instanceId };
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

function previewChildEntry(): string {
  return fileURLToPath(new URL('./preview-child.js', import.meta.url));
}

export function spawnPreviewChild(launch: PreviewChildLaunch): PreviewChildHandle {
  const logDescriptor = openSync(launch.logFile, 'a');
  try {
    return spawn(process.execPath, [previewChildEntry()], {
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

export function waitForReadyPreviewChild(
  child: PreviewChildHandle,
  launch: PreviewChildLaunch,
  timeoutMs: number,
  dependencyOverrides: Partial<PreviewProcessTimerDependencies> = {},
): Promise<ReadyPreviewChild> {
  const dependencies = { ...DEFAULT_TIMER_DEPENDENCIES, ...dependencyOverrides };
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: unknown = null;
    const finish = (result: ReadyPreviewChild | Error): void => {
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
      if (message.type === 'committed') {
        finish(new Error('Preview child sent a commit acknowledgement before readiness'));
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
      () => finish(new Error('Preview did not become ready within 10 seconds')),
      Math.max(0, timeoutMs),
    );
  });
}

export function commitReadyPreviewChild(
  child: PreviewChildHandle,
  instanceId: string,
  timeoutMs: number,
  dependencyOverrides: Partial<PreviewProcessTimerDependencies> = {},
): Promise<void> {
  const dependencies = { ...DEFAULT_TIMER_DEPENDENCIES, ...dependencyOverrides };
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: unknown = null;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) dependencies.clearTimer(timer);
      child.removeListener('message', onMessage);
      child.removeListener('error', onError);
      child.removeListener('exit', onExit);
      if (error === undefined) resolve();
      else reject(error);
    };
    const onMessage = (value: unknown): void => {
      const message = parseChildMessage(value);
      if (message?.type !== 'committed' || message.instanceId !== instanceId) {
        finish(new Error('Preview child commit acknowledgement did not match the launch instance'));
        return;
      }
      finish();
    };
    const onError = (error: unknown): void => {
      finish(
        new Error(
          `Preview child failed before commit: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    };
    const onExit = (code: unknown, signal: unknown): void => {
      finish(
        new Error(
          `Preview child exited before commit (code ${String(code)}, signal ${String(signal)})`,
        ),
      );
    };
    if (child.send === undefined) {
      finish(new Error('Preview child IPC channel is unavailable before commit'));
      return;
    }
    child.on('message', onMessage);
    child.on('error', onError);
    child.on('exit', onExit);
    timer = dependencies.setTimer(
      () => finish(new Error('Preview child did not acknowledge runtime commit')),
      Math.max(0, timeoutMs),
    );
    try {
      child.send({ type: 'commit', instanceId }, (error) => {
        if (error !== null) finish(new Error(`Preview child commit failed: ${error.message}`));
      });
    } catch (error) {
      finish(
        new Error(
          `Preview child commit failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }
  });
}

function childHasExited(child: PreviewChildHandle): boolean {
  return child.exitCode !== undefined && child.exitCode !== null
    ? true
    : child.signalCode !== undefined && child.signalCode !== null;
}

function waitForChildExit(
  child: PreviewChildHandle,
  timeoutMs: number,
  dependencies: PreviewProcessTimerDependencies,
): Promise<boolean> {
  if (childHasExited(child)) return Promise.resolve(true);
  if (timeoutMs <= 0) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    let timer: unknown = null;
    const finish = (didExit: boolean): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) dependencies.clearTimer(timer);
      child.removeListener('exit', onExit);
      resolve(didExit);
    };
    const onExit = (): void => finish(true);
    child.on('exit', onExit);
    if (childHasExited(child)) {
      finish(true);
      return;
    }
    timer = dependencies.setTimer(() => finish(false), timeoutMs);
  });
}

function signalOwnedChild(child: PreviewChildHandle, signal: NodeJS.Signals): void {
  try {
    child.kill(signal);
  } catch {
    // The owned child may have exited between the state check and signal.
  }
}

function disconnectOwnedChild(child: PreviewChildHandle): void {
  try {
    child.disconnect?.();
  } catch {
    // The IPC channel may already be closed.
  }
  child.unref();
}

export async function terminateOwnedPreviewChild(
  child: PreviewChildHandle,
  options: PreviewChildTerminationOptions,
  dependencyOverrides: Partial<PreviewProcessTimerDependencies> = {},
): Promise<boolean> {
  const dependencies = { ...DEFAULT_TIMER_DEPENDENCIES, ...dependencyOverrides };
  if (childHasExited(child)) {
    disconnectOwnedChild(child);
    return true;
  }

  const termWaitMs = Math.max(
    0,
    Math.min(options.termGraceMs, options.deadline - dependencies.now()),
  );
  const termExit = waitForChildExit(child, termWaitMs, dependencies);
  signalOwnedChild(child, 'SIGTERM');
  if (await termExit) {
    disconnectOwnedChild(child);
    return true;
  }

  const killWaitMs = Math.max(0, options.deadline - dependencies.now());
  const killExit = waitForChildExit(child, killWaitMs, dependencies);
  signalOwnedChild(child, 'SIGKILL');
  const didExit = await killExit;
  disconnectOwnedChild(child);
  return didExit;
}

export function detachReadyPreviewChild(child: PreviewChildHandle): void {
  child.disconnect?.();
  child.unref();
}
