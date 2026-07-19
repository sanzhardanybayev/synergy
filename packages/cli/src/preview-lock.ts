import { randomUUID } from 'node:crypto';
import {
  constants,
  closeSync,
  copyFileSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

interface PreviewStartLockRecord {
  attemptId: string;
  pid: number;
  createdAt: string;
}

export interface PreviewStartLockOptions {
  path: string;
  attemptId: string;
  deadline: number;
  staleMs: number;
  pollIntervalMs: number;
}

export interface PreviewStartLockDependencies {
  copyFileExclusive(source: string, destination: string): void;
  createQuarantineId(): string;
  now(): number;
  processKill(pid: number, signal: 0): boolean;
  wallNow(): number;
  sleep(milliseconds: number): Promise<void>;
}

export interface AcquiredPreviewStartLock {
  lockMs: number;
  release(): boolean;
  updateOwnerPid(pid: number): boolean;
}

const DEFAULT_DEPENDENCIES: PreviewStartLockDependencies = {
  copyFileExclusive: (source, destination) =>
    copyFileSync(source, destination, constants.COPYFILE_EXCL),
  createQuarantineId: randomUUID,
  now: () => performance.now(),
  processKill: (pid, signal) => process.kill(pid, signal),
  wallNow: Date.now,
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasErrorCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

function readLockRecord(path: string | number): PreviewStartLockRecord | null {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (
      !isRecord(value) ||
      typeof value.attemptId !== 'string' ||
      typeof value.pid !== 'number' ||
      !Number.isSafeInteger(value.pid) ||
      value.pid <= 0 ||
      typeof value.createdAt !== 'string'
    ) {
      return null;
    }
    return { attemptId: value.attemptId, pid: value.pid, createdAt: value.createdAt };
  } catch {
    return null;
  }
}

function quarantinePath(
  path: string,
  attemptId: string,
  dependencies: PreviewStartLockDependencies,
): string {
  return `${path}.quarantine.${attemptId}.${dependencies.createQuarantineId()}`;
}

function listQuarantines(path: string): string[] {
  const directory = dirname(path);
  const prefix = `${basename(path)}.quarantine.`;
  return readdirSync(directory)
    .filter((entry) => entry.startsWith(prefix))
    .map((entry) => join(directory, entry));
}

function sameLockOwner(
  first: PreviewStartLockRecord | null,
  second: PreviewStartLockRecord | null,
) {
  return (
    first !== null &&
    second !== null &&
    first.attemptId === second.attemptId &&
    first.pid === second.pid
  );
}

function restoreWithoutOverwrite(
  capturedPath: string,
  lockPath: string,
  dependencies: PreviewStartLockDependencies,
): boolean {
  try {
    dependencies.copyFileExclusive(capturedPath, lockPath);
  } catch (error) {
    if (!hasErrorCode(error, 'EEXIST')) throw error;
    if (!sameLockOwner(readLockRecord(capturedPath), readLockRecord(lockPath))) return false;
  }
  unlinkSync(capturedPath);
  return true;
}

function captureCurrentLock(
  path: string,
  attemptId: string,
  dependencies: PreviewStartLockDependencies,
): string | null {
  const capturedPath = quarantinePath(path, attemptId, dependencies);
  try {
    renameSync(path, capturedPath);
    return capturedPath;
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return null;
    throw error;
  }
}

function recoverCapturedLock(
  path: string,
  attemptId: string,
  staleMs: number,
  dependencies: PreviewStartLockDependencies,
): boolean {
  const capturedPath = captureCurrentLock(path, attemptId, dependencies);
  if (capturedPath === null) return true;
  return recoverQuarantine(path, capturedPath, staleMs, dependencies);
}

function recoverQuarantine(
  path: string,
  capturedPath: string,
  staleMs: number,
  dependencies: PreviewStartLockDependencies,
): boolean {
  const capturedRecord = readLockRecord(capturedPath);
  let capturedAgeMs: number;
  try {
    capturedAgeMs = dependencies.wallNow() - statSync(capturedPath).mtimeMs;
  } catch (error) {
    restoreWithoutOverwrite(capturedPath, path, dependencies);
    throw error;
  }
  if (capturedAgeMs < staleMs) {
    restoreWithoutOverwrite(capturedPath, path, dependencies);
    return false;
  }
  if (capturedRecord === null) {
    unlinkSync(capturedPath);
    return true;
  }
  try {
    dependencies.processKill(capturedRecord.pid, 0);
  } catch (error) {
    if (hasErrorCode(error, 'ESRCH')) {
      unlinkSync(capturedPath);
      return true;
    }
  }
  restoreWithoutOverwrite(capturedPath, path, dependencies);
  return false;
}

function quarantineBlocksAcquisition(
  path: string,
  staleMs: number,
  dependencies: PreviewStartLockDependencies,
): boolean {
  let isBlocked = false;
  for (const capturedPath of listQuarantines(path)) {
    if (!recoverQuarantine(path, capturedPath, staleMs, dependencies)) isBlocked = true;
  }
  return isBlocked;
}

function mayBeStale(
  path: string,
  staleMs: number,
  dependencies: PreviewStartLockDependencies,
): boolean {
  try {
    return dependencies.wallNow() - statSync(path).mtimeMs >= staleMs;
  } catch {
    return true;
  }
}

function releaseOwnedLock(
  path: string,
  attemptId: string,
  dependencies: PreviewStartLockDependencies,
): boolean {
  const capturedPath = captureCurrentLock(path, attemptId, dependencies);
  if (capturedPath === null) return false;
  const capturedRecord = readLockRecord(capturedPath);
  if (capturedRecord?.attemptId === attemptId) {
    try {
      unlinkSync(capturedPath);
      return true;
    } catch {
      return false;
    }
  }

  restoreWithoutOverwrite(capturedPath, path, dependencies);
  return false;
}

function updateOwnedLockPid(path: string, attemptId: string, pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  let descriptor: number;
  try {
    descriptor = openSync(path, 'r+');
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return false;
    throw error;
  }
  try {
    const record = readLockRecord(descriptor);
    if (record?.attemptId !== attemptId) return false;
    const updated: PreviewStartLockRecord = { ...record, pid };
    ftruncateSync(descriptor, 0);
    writeSync(descriptor, `${JSON.stringify(updated)}\n`, 0, 'utf8');
    fsyncSync(descriptor);
    const descriptorState = fstatSync(descriptor);
    const pathState = statSync(path);
    return descriptorState.dev === pathState.dev && descriptorState.ino === pathState.ino;
  } finally {
    closeSync(descriptor);
  }
}

export async function acquirePreviewStartLock(
  options: PreviewStartLockOptions,
  dependencyOverrides: Partial<PreviewStartLockDependencies> = {},
): Promise<AcquiredPreviewStartLock> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencyOverrides };
  const lockStartedAt = dependencies.now();
  while (dependencies.now() < options.deadline) {
    if (quarantineBlocksAcquisition(options.path, options.staleMs, dependencies)) {
      const remainingMs = options.deadline - dependencies.now();
      if (remainingMs <= 0) break;
      await dependencies.sleep(Math.min(options.pollIntervalMs, remainingMs));
      continue;
    }
    try {
      const descriptor = openSync(options.path, 'wx', 0o600);
      try {
        const record: PreviewStartLockRecord = {
          attemptId: options.attemptId,
          pid: process.pid,
          createdAt: new Date(dependencies.wallNow()).toISOString(),
        };
        writeFileSync(descriptor, `${JSON.stringify(record)}\n`);
      } finally {
        closeSync(descriptor);
      }
      if (listQuarantines(options.path).length > 0) {
        releaseOwnedLock(options.path, options.attemptId, dependencies);
        const remainingMs = options.deadline - dependencies.now();
        if (remainingMs <= 0) break;
        await dependencies.sleep(Math.min(options.pollIntervalMs, remainingMs));
        continue;
      }
      return {
        lockMs: dependencies.now() - lockStartedAt,
        release: () => releaseOwnedLock(options.path, options.attemptId, dependencies),
        updateOwnerPid: (pid) => updateOwnedLockPid(options.path, options.attemptId, pid),
      };
    } catch (error) {
      if (!hasErrorCode(error, 'EEXIST')) throw error;
      if (
        mayBeStale(options.path, options.staleMs, dependencies) &&
        recoverCapturedLock(options.path, options.attemptId, options.staleMs, dependencies)
      ) {
        continue;
      }
      const remainingMs = options.deadline - dependencies.now();
      if (remainingMs <= 0) break;
      await dependencies.sleep(Math.min(options.pollIntervalMs, remainingMs));
    }
  }
  throw new Error(
    'Preview did not become ready within 10 seconds while waiting for its start lock',
  );
}
