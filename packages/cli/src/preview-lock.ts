import { randomUUID } from 'node:crypto';
import {
  closeSync,
  linkSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';

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
  createQuarantineId(): string;
  now(): number;
  wallNow(): number;
  sleep(milliseconds: number): Promise<void>;
}

export interface AcquiredPreviewStartLock {
  lockMs: number;
  release(): boolean;
}

const DEFAULT_DEPENDENCIES: PreviewStartLockDependencies = {
  createQuarantineId: randomUUID,
  now: () => performance.now(),
  wallNow: Date.now,
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasErrorCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

function readLockRecord(path: string): PreviewStartLockRecord | null {
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
  return `${path}.${attemptId}.${dependencies.createQuarantineId()}.quarantine`;
}

function restoreWithoutOverwrite(capturedPath: string, lockPath: string): void {
  try {
    linkSync(capturedPath, lockPath);
  } catch (error) {
    if (!hasErrorCode(error, 'EEXIST')) throw error;
  } finally {
    try {
      unlinkSync(capturedPath);
    } catch {
      // A concurrent recovery may already have removed the captured link.
    }
  }
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

  try {
    const capturedRecord = readLockRecord(capturedPath);
    const capturedAgeMs = dependencies.wallNow() - statSync(capturedPath).mtimeMs;
    if (capturedAgeMs >= staleMs) {
      unlinkSync(capturedPath);
      return true;
    }

    if (capturedRecord?.attemptId === attemptId) {
      unlinkSync(capturedPath);
      return true;
    }

    restoreWithoutOverwrite(capturedPath, path);
    return false;
  } catch {
    try {
      restoreWithoutOverwrite(capturedPath, path);
    } catch {
      // A successor may already be authoritative at the lock path.
    }
    return false;
  }
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

  try {
    restoreWithoutOverwrite(capturedPath, path);
  } catch {
    // A successor may already be authoritative at the lock path.
  }
  return false;
}

export async function acquirePreviewStartLock(
  options: PreviewStartLockOptions,
  dependencyOverrides: Partial<PreviewStartLockDependencies> = {},
): Promise<AcquiredPreviewStartLock> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencyOverrides };
  const lockStartedAt = dependencies.now();
  while (dependencies.now() < options.deadline) {
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
      return {
        lockMs: dependencies.now() - lockStartedAt,
        release: () => releaseOwnedLock(options.path, options.attemptId, dependencies),
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
