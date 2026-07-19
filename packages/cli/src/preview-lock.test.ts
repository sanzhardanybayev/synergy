import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
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
}

function writeLock(path: string, attemptId: string, padding = '', pid = process.pid): void {
  const record: LockRecord = { attemptId, pid, createdAt: new Date().toISOString() };
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
      acquirePreviewStartLock(
        {
          path: lockPath,
          attemptId: 'new-attempt',
          deadline: performance.now() + 150,
          staleMs: 1_000,
          pollIntervalMs: 1,
        },
        {
          processKill: (pid) => {
            if (pid === 91_001) {
              throw Object.assign(new Error('not found'), { code: 'ESRCH' });
            }
            return true;
          },
        },
      ),
    ).rejects.toThrow(/start lock/i);

    const [exitCode] = await racerExit;
    expect(exitCode).toBe(0);
    expect(readAttemptId(lockPath)).toBe('fresh-successor');
  });

  it('recovers a stale owner and removes its quarantine artifact', async () => {
    writeLock(lockPath, 'stale-attempt', '', 91_002);
    const oldTime = new Date(Date.now() - 60_000);
    utimesSync(lockPath, oldTime, oldTime);

    const lock = await acquirePreviewStartLock(
      {
        path: lockPath,
        attemptId: 'replacement-attempt',
        deadline: performance.now() + 1_000,
        staleMs: 1_000,
        pollIntervalMs: 1,
      },
      {
        processKill: () => {
          throw Object.assign(new Error('not found'), { code: 'ESRCH' });
        },
      },
    );

    expect(readAttemptId(lockPath)).toBe('replacement-attempt');
    expect(lock.release()).toBe(true);
    expect(() => readFileSync(lockPath)).toThrow();
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
    writeLock(lockPath, 'active-attempt', '', 91_005);
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
          processKill: () => true,
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

  it.each([
    ['live', (_pid: number, _signal: 0): boolean => true],
    [
      'EPERM',
      (_pid: number, _signal: 0): boolean => {
        throw Object.assign(new Error('denied'), { code: 'EPERM' });
      },
    ],
  ] as const)('never recovers an old lock whose owner is %s', async (_label, processKill) => {
    writeLock(lockPath, 'active-attempt', '', 91_003);
    const oldTime = new Date(Date.now() - 60_000);
    utimesSync(lockPath, oldTime, oldTime);

    await expect(
      acquirePreviewStartLock(
        {
          path: lockPath,
          attemptId: 'replacement-attempt',
          deadline: performance.now() + 20,
          staleMs: 1,
          pollIntervalMs: 1,
        },
        { processKill },
      ),
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
      acquirePreviewStartLock(
        {
          path: lockPath,
          attemptId: 'attempt-c',
          deadline: performance.now() + 20,
          staleMs: 1,
          pollIntervalMs: 1,
        },
        { processKill: () => true },
      ),
    ).rejects.toThrow(/start lock/i);

    expect(readAttemptId(lockPath)).toBe('attempt-a');
    expect(existsSync(quarantinePath)).toBe(false);
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
    writeLock(lockPath, 'attempt-b');
    expect(() => lock.release()).toThrow('restore failed');

    await expect(
      acquirePreviewStartLock(
        {
          path: lockPath,
          attemptId: 'attempt-d',
          deadline: performance.now() + 20,
          staleMs: 1,
          pollIntervalMs: 1,
        },
        { processKill: () => true },
      ),
    ).rejects.toThrow(/start lock/i);

    expect(readAttemptId(lockPath)).toBe('attempt-b');
    expect(hasLockQuarantine(lockPath)).toBe(false);
  });
});
