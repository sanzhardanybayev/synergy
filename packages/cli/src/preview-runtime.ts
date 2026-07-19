import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  constants,
  closeSync,
  copyFileSync,
  openSync,
  readFileSync,
  readdirSync,
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
  timings?: PreviewTimings;
}

export interface PreviewTimings {
  lockMs: number;
  launchMs: number;
  listenMs: number;
  healthMs: number;
  totalMs: number;
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

export interface PreviewRuntimeFileDependencies {
  copyFileExclusive(source: string, destination: string): void;
}

const DEFAULT_FILE_DEPENDENCIES: PreviewRuntimeFileDependencies = {
  copyFileExclusive: (source, destination) =>
    copyFileSync(source, destination, constants.COPYFILE_EXCL),
};

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

function isDuration(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function parseTimings(value: unknown): PreviewTimings | null {
  if (!isRecord(value)) return null;
  const keys = ['lockMs', 'launchMs', 'listenMs', 'healthMs', 'totalMs'];
  if (Object.keys(value).length !== keys.length || keys.some((key) => !(key in value))) {
    return null;
  }
  const { lockMs, launchMs, listenMs, healthMs, totalMs } = value;
  if (
    !isDuration(lockMs) ||
    !isDuration(launchMs) ||
    !isDuration(listenMs) ||
    !isDuration(healthMs) ||
    !isDuration(totalMs)
  ) {
    return null;
  }
  return { lockMs, launchMs, listenMs, healthMs, totalMs };
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

function quarantinePath(path: string): string {
  return `${path}.quarantine.${process.pid}.${randomUUID()}`;
}

function listRuntimeQuarantines(path: string): string[] {
  const directory = dirname(path);
  const prefix = `${basename(path)}.quarantine.`;
  try {
    return readdirSync(directory)
      .filter((entry) => entry.startsWith(prefix))
      .map((entry) => join(directory, entry));
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return [];
    throw error;
  }
}

function restoreCapturedFile(
  capturedPath: string,
  destinationPath: string,
  dependencies: PreviewRuntimeFileDependencies,
): void {
  try {
    dependencies.copyFileExclusive(capturedPath, destinationPath);
  } catch (error) {
    if (!hasErrorCode(error, 'EEXIST')) throw error;
  }
  unlinkSync(capturedPath);
}

function parsePreviewRuntime(value: unknown): PreviewRuntimeState | null {
  if (!isRecord(value)) return null;

  const requiredKeys = [
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
  const allowedKeys = new Set([...requiredKeys, 'timings']);
  if (
    requiredKeys.some((key) => !(key in value)) ||
    Object.keys(value).some((key) => !allowedKeys.has(key))
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
    timings,
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
  let parsedTimings: PreviewTimings | undefined;
  if (timings !== undefined) {
    const candidate = parseTimings(timings);
    if (candidate === null) return null;
    parsedTimings = candidate;
  }

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
    ...(parsedTimings === undefined ? {} : { timings: parsedTimings }),
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

function readRuntimeFile(path: string): PreviewRuntimeState | null {
  try {
    return parsePreviewRuntime(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return null;
  }
}

export function readPreviewRuntime(path: string): PreviewRuntimeState | null {
  const canonical = readRuntimeFile(path);
  if (canonical !== null) return canonical;
  for (const capturedPath of listRuntimeQuarantines(path)) {
    const captured = readRuntimeFile(capturedPath);
    if (captured !== null) return captured;
  }
  return readRuntimeFile(path);
}

export function writePreviewRuntime(path: string, state: PreviewRuntimeState): void {
  const validatedState = parsePreviewRuntime(state);
  if (validatedState === null) throw new TypeError('Invalid preview runtime state');

  const tempPath = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  const fileDescriptor = openSync(tempPath, 'wx', 0o600);
  let shouldRemoveTempFile = true;

  try {
    writeSync(fileDescriptor, `${JSON.stringify(validatedState)}\n`, undefined, 'utf8');
    closeSync(fileDescriptor);
    renameSync(tempPath, path);
    shouldRemoveTempFile = false;
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
}

export function removeOwnedPreviewRuntime(
  path: string,
  instanceId: string,
  dependencyOverrides: Partial<PreviewRuntimeFileDependencies> = {},
): boolean {
  const dependencies = { ...DEFAULT_FILE_DEPENDENCIES, ...dependencyOverrides };
  const capturedPath = quarantinePath(path);
  try {
    renameSync(path, capturedPath);
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return false;
    throw error;
  }

  const runtime = readRuntimeFile(capturedPath);
  if (runtime !== null && runtime.instanceId === instanceId) {
    unlinkSync(capturedPath);
    return true;
  }

  restoreCapturedFile(capturedPath, path, dependencies);
  return false;
}
