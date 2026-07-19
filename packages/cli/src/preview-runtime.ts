import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

export interface PreviewRuntimeState {
  schemaVersion: 1;
  protocolVersion: 1;
  state: 'ready';
  instanceId: string;
  projectId: string;
  pid: number;
  host: '127.0.0.1';
  port: number;
  origin: string;
  preferredPort: number;
  strictPort: boolean;
  startedAt: string;
  controlToken: string;
  toolVersion: string;
}

export interface PreviewHealth {
  protocolVersion: 1;
  state: 'ready';
  instanceId: string;
  projectId: string;
  pid: number;
  port: number;
}

const LOOPBACK_HOST = '127.0.0.1';
const MAX_PORT = 65_535;
const CONTROL_TOKEN_PATTERN = /^[0-9a-f]{64}$/;
const MUTATION_LOCK_RETRY_MS = 10;
const MUTATION_LOCK_TIMEOUT_MS = 5_000;
const MUTATION_LOCK_SLEEP = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_PORT;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isIsoTimestamp(value: unknown): value is string {
  if (!isNonEmptyString(value)) return false;

  const parsedTimestamp = new Date(value);
  return !Number.isNaN(parsedTimestamp.getTime()) && parsedTimestamp.toISOString() === value;
}

function isControlToken(value: unknown): value is string {
  return typeof value === 'string' && CONTROL_TOKEN_PATTERN.test(value);
}

function hasErrorCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

function withMutationLock<T>(runtimePath: string, operation: () => T): T {
  const lockPath = `${runtimePath}.mutation.lock`;
  const deadline = Date.now() + MUTATION_LOCK_TIMEOUT_MS;
  let lockDescriptor: number;

  while (true) {
    try {
      lockDescriptor = openSync(lockPath, 'wx', 0o600);
      break;
    } catch (error) {
      if (!hasErrorCode(error, 'EEXIST') || Date.now() >= deadline) throw error;
      Atomics.wait(MUTATION_LOCK_SLEEP, 0, 0, MUTATION_LOCK_RETRY_MS);
    }
  }

  try {
    return operation();
  } finally {
    try {
      closeSync(lockDescriptor);
    } finally {
      unlinkSync(lockPath);
    }
  }
}

function parsePreviewRuntime(value: unknown): PreviewRuntimeState | null {
  if (!isRecord(value)) return null;

  const expectedKeys = [
    'schemaVersion',
    'protocolVersion',
    'state',
    'instanceId',
    'projectId',
    'pid',
    'host',
    'port',
    'origin',
    'preferredPort',
    'strictPort',
    'startedAt',
    'controlToken',
    'toolVersion',
  ];
  if (
    Object.keys(value).length !== expectedKeys.length ||
    expectedKeys.some((key) => !(key in value))
  ) {
    return null;
  }

  const {
    schemaVersion,
    protocolVersion,
    state,
    instanceId,
    projectId,
    pid,
    host,
    port,
    origin,
    preferredPort,
    strictPort,
    startedAt,
    controlToken,
    toolVersion,
  } = value;

  if (
    schemaVersion !== 1 ||
    protocolVersion !== 1 ||
    state !== 'ready' ||
    !isNonEmptyString(instanceId) ||
    !isNonEmptyString(projectId) ||
    !isPositiveInteger(pid) ||
    host !== LOOPBACK_HOST ||
    !isPort(port) ||
    !isPort(preferredPort) ||
    typeof strictPort !== 'boolean' ||
    !isIsoTimestamp(startedAt) ||
    !isControlToken(controlToken) ||
    !isNonEmptyString(toolVersion)
  ) {
    return null;
  }

  const derivedOrigin = deriveLoopbackOrigin(port);
  if (origin !== derivedOrigin) return null;

  return {
    schemaVersion,
    protocolVersion,
    state,
    instanceId,
    projectId,
    pid,
    host,
    port,
    origin: derivedOrigin,
    preferredPort,
    strictPort,
    startedAt,
    controlToken,
    toolVersion,
  };
}

export function deriveProjectId(canonicalRoot: string): string {
  return `sha256:${createHash('sha256').update(canonicalRoot).digest('hex')}`;
}

export function deriveLoopbackOrigin(port: number): string {
  if (!isPort(port)) throw new RangeError(`Invalid loopback port: ${port}`);
  return `http://${LOOPBACK_HOST}:${port}`;
}

export function generateControlToken(): string {
  return randomBytes(32).toString('hex');
}

export function readPreviewRuntime(path: string): PreviewRuntimeState | null {
  try {
    return parsePreviewRuntime(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return null;
  }
}

export function writePreviewRuntime(path: string, state: PreviewRuntimeState): void {
  const validatedState = parsePreviewRuntime(state);
  if (validatedState === null) throw new TypeError('Invalid preview runtime state');

  withMutationLock(path, () => {
    const tempPath = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
    const fileDescriptor = openSync(tempPath, 'wx', 0o600);
    let shouldRemoveTempFile = true;

    try {
      writeSync(fileDescriptor, `${JSON.stringify(validatedState)}\n`, undefined, 'utf8');
      closeSync(fileDescriptor);
      renameSync(tempPath, path);
      shouldRemoveTempFile = false;
      chmodSync(path, 0o600);
    } finally {
      if (shouldRemoveTempFile) {
        try {
          closeSync(fileDescriptor);
        } catch {
          // The descriptor is already closed when writing or renaming fails after closeSync.
        }
        try {
          unlinkSync(tempPath);
        } catch {
          // The temporary file is absent when renameSync succeeds.
        }
      }
    }
  });
}

export function removeOwnedPreviewRuntime(path: string, instanceId: string): boolean {
  try {
    return withMutationLock(path, () => {
      const runtime = readPreviewRuntime(path);
      if (runtime === null || runtime.instanceId !== instanceId) return false;

      unlinkSync(path);
      return true;
    });
  } catch {
    return false;
  }
}
