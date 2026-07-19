import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquirePreviewStartLock } from './preview-lock.js';

interface LockRecord {
  attemptId: string;
  pid: number;
  createdAt: string;
}

function writeLock(path: string, attemptId: string, padding = ''): void {
  const record: LockRecord = { attemptId, pid: process.pid, createdAt: new Date().toISOString() };
  writeFileSync(path, `${JSON.stringify(record)}${padding}\n`);
}

function readAttemptId(path: string): string {
  return (JSON.parse(readFileSync(path, 'utf8')) as LockRecord).attemptId;
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
    writeLock(lockPath, 'stale-attempt', ' '.repeat(75_000_000));
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
    writeLock(lockPath, 'stale-attempt');
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
});
