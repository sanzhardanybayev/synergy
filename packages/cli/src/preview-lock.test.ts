import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquirePreviewStartLock } from './preview-lock.js';

interface LockRecord {
  attemptId: string;
  pid: number;
  createdAt: string;
  leaseExpiresAt?: string;
}

function writeLock(
  path: string,
  attemptId: string,
  padding = '',
  pid = process.pid,
  leaseExpiresAt?: string,
): void {
  const record: LockRecord = {
    attemptId,
    pid,
    createdAt: new Date().toISOString(),
    ...(leaseExpiresAt === undefined ? {} : { leaseExpiresAt }),
  };
  writeFileSync(path, `${JSON.stringify(record)}${padding}\n`);
}

function readAttemptId(path: string): string {
  return (JSON.parse(readFileSync(path, 'utf8')) as LockRecord).attemptId;
}

function hasLockQuarantine(path: string): boolean {
  const prefix = `${basename(path)}.quarantine.`;
  return readdirSync(dirname(path)).some((entry) => entry.startsWith(prefix));
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

describe('preview start lock', () => {
  let tempDir: string;
  let lockPath: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `synergy-preview-lock-${Date.now()}-${Math.random()}`);
    mkdirSync(tempDir, { recursive: true });
    lockPath = join(tempDir, 'preview.start.lock');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('releases only its captured owner without overwriting a successor', async () => {
    const lock = await acquirePreviewStartLock({
      path: lockPath,
      attemptId: 'attempt-a',
      deadline: performance.now() + 1_000,
      staleMs: 10_000,
      pollIntervalMs: 1,
    });
    rmSync(lockPath);
    writeLock(lockPath, 'attempt-b');

    expect(lock.release()).toBe(false);
    expect(readAttemptId(lockPath)).toBe('attempt-b');
  });

  it('does not delete a fresh replacement raced into a stale-lock takeover', async () => {
    writeLock(lockPath, 'stale-attempt', ' '.repeat(75_000_000), 91_001);
    const oldTime = new Date(Date.now() - 60_000);
    utimesSync(lockPath, oldTime, oldTime);
    const successor: LockRecord = {
      attemptId: 'fresh-successor',
      pid: process.pid,
      createdAt: new Date().toISOString(),
    };
    const readyPath = join(tempDir, 'racer.ready');
    const racer = spawn(
      process.execPath,
      [
        '-e',
        "const fs=require('node:fs');const [p,v,ready]=process.argv.slice(1),end=Date.now()+2000;fs.writeFileSync(ready,'ready');const tick=()=>{try{const fd=fs.openSync(p,'wx');fs.writeFileSync(fd,v);fs.closeSync(fd);process.exit(0)}catch(e){if(e.code!=='EEXIST')process.exit(1)}if(Date.now()>=end)process.exit(2);setImmediate(tick)};tick();",
        lockPath,
        JSON.stringify(successor),
        readyPath,
      ],
      { stdio: 'ignore' },
    );
    const racerExit = once(racer, 'exit');
    await waitForFile(readyPath);

    await expect(
      acquirePreviewStartLock({
        path: lockPath,
        attemptId: 'new-attempt',
        deadline: performance.now() + 150,
        staleMs: 1_000,
        pollIntervalMs: 1,
      }),
    ).rejects.toThrow(/start lock/i);

    const [exitCode] = await racerExit;
    expect(exitCode).toBe(0);
    expect(readAttemptId(lockPath)).toBe('fresh-successor');
  });

  it('recovers a stale owner and removes its quarantine artifact', async () => {
    writeLock(lockPath, 'stale-attempt', '', 91_002);
    const oldTime = new Date(Date.now() - 60_000);
    utimesSync(lockPath, oldTime, oldTime);

    const lock = await acquirePreviewStartLock({
      path: lockPath,
      attemptId: 'replacement-attempt',
      deadline: performance.now() + 1_000,
      staleMs: 1_000,
      pollIntervalMs: 1,
    });

    expect(readAttemptId(lockPath)).toBe('replacement-attempt');
    expect(lock.release()).toBe(true);
    expect(() => readFileSync(lockPath)).toThrow();
  });

  it('recovers an expired lease even when its PID has been reused by a live process', async () => {
    writeLock(lockPath, 'crashed-attempt', '', process.pid);
    const oldTime = new Date(Date.now() - 60_000);
    utimesSync(lockPath, oldTime, oldTime);

    const lock = await acquirePreviewStartLock({
      path: lockPath,
      attemptId: 'replacement-attempt',
      deadline: performance.now() + 1_000,
      staleMs: 1_000,
      pollIntervalMs: 1,
    });

    expect(readAttemptId(lockPath)).toBe('replacement-attempt');
    expect(lock.release()).toBe(true);
  });

  it('does not restore or consume a fresh release quarantine owned by another attempt', async () => {
    await acquirePreviewStartLock({
      path: lockPath,
      attemptId: 'releasing-attempt',
      deadline: performance.now() + 1_000,
      staleMs: 10_000,
      pollIntervalMs: 1,
    });
    const releaseQuarantine = `${lockPath}.quarantine.releasing-attempt.manual`;
    renameSync(lockPath, releaseQuarantine);
    let observedReleaseFence = false;

    const contender = await acquirePreviewStartLock(
      {
        path: lockPath,
        attemptId: 'contending-attempt',
        deadline: performance.now() + 1_000,
        staleMs: 10_000,
        pollIntervalMs: 1,
      },
      {
        sleep: async () => {
          expect(existsSync(lockPath)).toBe(false);
          expect(existsSync(releaseQuarantine)).toBe(true);
          observedReleaseFence = true;
          rmSync(releaseQuarantine);
        },
      },
    );

    expect(observedReleaseFence).toBe(true);
    expect(readAttemptId(lockPath)).toBe('contending-attempt');
    expect(contender.release()).toBe(true);
  });

  it.each(['EPERM', 'ENOTSUP', 'EIO'])(
    'preserves the captured lock quarantine and propagates a %s restore failure',
    async (code) => {
      const lock = await acquirePreviewStartLock(
        {
          path: lockPath,
          attemptId: 'attempt-a',
          deadline: performance.now() + 1_000,
          staleMs: 10_000,
          pollIntervalMs: 1,
        },
        {
          copyFileExclusive: () => {
            throw Object.assign(new Error(`restore ${code}`), { code });
          },
        },
      );
      rmSync(lockPath);
      writeLock(lockPath, 'attempt-b');

      expect(() => lock.release()).toThrow(`restore ${code}`);
      expect(existsSync(lockPath)).toBe(false);
      expect(hasLockQuarantine(lockPath)).toBe(true);
    },
  );

  it('does not retry or discard a captured lock after a transient restore failure', async () => {
    writeLock(lockPath, 'active-attempt', '', 91_005, new Date(Date.now() + 60_000).toISOString());
    const oldTime = new Date(Date.now() - 60_000);
    utimesSync(lockPath, oldTime, oldTime);
    let restoreAttempts = 0;

    await expect(
      acquirePreviewStartLock(
        {
          path: lockPath,
          attemptId: 'attempt-b',
          deadline: performance.now() + 1_000,
          staleMs: 1,
          pollIntervalMs: 1,
        },
        {
          copyFileExclusive: () => {
            restoreAttempts += 1;
            throw Object.assign(
              new Error(restoreAttempts === 1 ? 'transient restore failure' : 'retried restore'),
              { code: restoreAttempts === 1 ? 'EIO' : 'ENOTSUP' },
            );
          },
        },
      ),
    ).rejects.toThrow('transient restore failure');
    expect(restoreAttempts).toBe(1);
    expect(hasLockQuarantine(lockPath)).toBe(true);
  });

  it('never recovers an unexpired lease even when its file timestamp looks stale', async () => {
    writeLock(lockPath, 'active-attempt', '', 91_003, new Date(Date.now() + 60_000).toISOString());
    const oldTime = new Date(Date.now() - 60_000);
    utimesSync(lockPath, oldTime, oldTime);
    await expect(
      acquirePreviewStartLock({
        path: lockPath,
        attemptId: 'replacement-attempt',
        deadline: performance.now() + 20,
        staleMs: 1,
        pollIntervalMs: 1,
      }),
    ).rejects.toThrow(/start lock/i);
    expect(readAttemptId(lockPath)).toBe('active-attempt');
  });

  it('updates an acquired lock owner to the child PID before retaining the fence', async () => {
    const lock = await acquirePreviewStartLock({
      path: lockPath,
      attemptId: 'attempt-a',
      deadline: performance.now() + 1_000,
      staleMs: 10_000,
      pollIntervalMs: 1,
    });

    expect(lock.updateOwnerPid(91_004)).toBe(true);
    expect(JSON.parse(readFileSync(lockPath, 'utf8'))).toMatchObject({
      attemptId: 'attempt-a',
      pid: 91_004,
    });
  });

  it('keeps canonical parent ownership intact and a child fence when atomic transfer fails', async () => {
    let ownerTempRecord: LockRecord | null = null;
    let ownerTempMode: number | null = null;
    const lock = await acquirePreviewStartLock(
      {
        path: lockPath,
        attemptId: 'attempt-transfer',
        deadline: performance.now() + 1_000,
        staleMs: 10_000,
        pollIntervalMs: 1,
      },
      {
        publishOwnerRecord: (source) => {
          ownerTempRecord = JSON.parse(readFileSync(source, 'utf8')) as LockRecord;
          ownerTempMode = statSync(source).mode & 0o777;
          throw Object.assign(new Error('publish interrupted'), { code: 'EIO' });
        },
      },
    );

    expect(() => lock.updateOwnerPid(91_006)).toThrow('publish interrupted');
    expect(JSON.parse(readFileSync(lockPath, 'utf8'))).toMatchObject({
      attemptId: 'attempt-transfer',
      pid: process.pid,
    });
    const childFence = readdirSync(tempDir).find((entry) =>
      entry.startsWith('preview.start.lock.quarantine.'),
    );
    expect(childFence).toBeDefined();
    if (childFence === undefined) throw new Error('child fence was not published');
    const childFencePath = join(tempDir, childFence);
    expect(JSON.parse(readFileSync(childFencePath, 'utf8'))).toMatchObject({
      attemptId: 'attempt-transfer',
      pid: 91_006,
    });
    expect(statSync(childFencePath).mode & 0o777).toBe(0o600);
    expect(ownerTempRecord).toMatchObject({
      attemptId: 'attempt-transfer',
      pid: 91_006,
    });
    expect(ownerTempMode).toBe(0o600);
    expect(readdirSync(tempDir).some((entry) => entry.includes('.owner.tmp.'))).toBe(false);

    expect(lock.release()).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
    expect(hasLockQuarantine(lockPath)).toBe(false);
  });

  it('does not let a contender acquire while a live lock is captured in quarantine', async () => {
    await acquirePreviewStartLock({
      path: lockPath,
      attemptId: 'attempt-a',
      deadline: performance.now() + 1_000,
      staleMs: 10_000,
      pollIntervalMs: 1,
    });
    const quarantinePath = `${lockPath}.quarantine.attempt-a.manual`;
    renameSync(lockPath, quarantinePath);

    await expect(
      acquirePreviewStartLock({
        path: lockPath,
        attemptId: 'attempt-c',
        deadline: performance.now() + 20,
        staleMs: 1,
        pollIntervalMs: 1,
      }),
    ).rejects.toThrow(/start lock/i);

    expect(existsSync(lockPath)).toBe(false);
    expect(readAttemptId(quarantinePath)).toBe('attempt-a');
  });

  it('does not let a later contender acquire after a restore failure leaves quarantine', async () => {
    const lock = await acquirePreviewStartLock(
      {
        path: lockPath,
        attemptId: 'attempt-a',
        deadline: performance.now() + 1_000,
        staleMs: 10_000,
        pollIntervalMs: 1,
      },
      {
        copyFileExclusive: () => {
          throw Object.assign(new Error('restore failed'), { code: 'EIO' });
        },
      },
    );
    rmSync(lockPath);
    writeLock(lockPath, 'attempt-b', '', process.pid, new Date(Date.now() + 60_000).toISOString());
    expect(() => lock.release()).toThrow('restore failed');

    await expect(
      acquirePreviewStartLock({
        path: lockPath,
        attemptId: 'attempt-d',
        deadline: performance.now() + 20,
        staleMs: 1,
        pollIntervalMs: 1,
      }),
    ).rejects.toThrow(/start lock/i);

    expect(existsSync(lockPath)).toBe(false);
    expect(hasLockQuarantine(lockPath)).toBe(true);
  });
});
