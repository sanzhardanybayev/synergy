import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { runLefthookInstall } from '../../../scripts/install-lefthook.mjs';

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
const temporaryRoots = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeTemporaryRoot() {
  const root = mkdtempSync(join(tmpdir(), 'synergy-lefthook-test-'));
  temporaryRoots.push(root);
  return root;
}

function spawnResult(status, error) {
  return {
    pid: 1,
    output: [],
    stdout: null,
    stderr: null,
    status,
    signal: null,
    error,
  };
}

describe('lefthook prepare installer', () => {
  it('skips a nested directory that does not own the enclosing checkout metadata', () => {
    const enclosingRoot = makeTemporaryRoot();
    mkdirSync(join(enclosingRoot, '.git'));
    const archiveRoot = join(enclosingRoot, 'extracted-archive');
    mkdirSync(archiveRoot);
    const calls = [];
    let output = '';

    const exitCode = runLefthookInstall({
      cwd: archiveRoot,
      runProcess(command, args, options) {
        calls.push({ command, args, options });
        throw new Error('Lefthook must not run for inherited Git metadata');
      },
      writeOutput(message) {
        output += message;
      },
    });

    expect(exitCode).toBe(0);
    expect(calls).toEqual([]);
    expect(output).toBe('Skipping lefthook install: not a Git checkout.\n');
  });

  it('invokes lefthook when cwd owns a .git directory', () => {
    const checkoutRoot = makeTemporaryRoot();
    mkdirSync(join(checkoutRoot, '.git'));
    const calls = [];

    const exitCode = runLefthookInstall({
      cwd: checkoutRoot,
      runProcess(command, args, options) {
        calls.push({ command, args, options });
        return spawnResult(0);
      },
      writeOutput() {},
    });

    expect(exitCode).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe(process.execPath);
    expect(calls[0]?.args[0]).toMatch(/node_modules[/\\]lefthook[/\\]bin[/\\]index\.js$/u);
    expect(calls[0]?.args[1]).toBe('install');
    expect(calls[0]?.options).toEqual({ cwd: checkoutRoot, stdio: 'inherit' });
  });

  it('invokes lefthook when cwd owns a worktree .git file', () => {
    const worktreeRoot = makeTemporaryRoot();
    writeFileSync(join(worktreeRoot, '.git'), 'gitdir: ../metadata/worktrees/fixture\n', 'utf8');
    const calls = [];

    const exitCode = runLefthookInstall({
      cwd: worktreeRoot,
      runProcess(command, args, options) {
        calls.push({ command, args, options });
        return spawnResult(0);
      },
      writeOutput() {},
    });

    expect(exitCode).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe(process.execPath);
    expect(calls[0]?.args[1]).toBe('install');
    expect(calls[0]?.options).toEqual({ cwd: worktreeRoot, stdio: 'inherit' });
  });

  it('propagates a lefthook installation failure', () => {
    const checkoutRoot = makeTemporaryRoot();
    mkdirSync(join(checkoutRoot, '.git'));

    const exitCode = runLefthookInstall({
      cwd: checkoutRoot,
      runProcess() {
        return spawnResult(23);
      },
      writeOutput() {},
    });

    expect(exitCode).toBe(23);
  });

  it('does not mask a process-spawn error', () => {
    const checkoutRoot = makeTemporaryRoot();
    mkdirSync(join(checkoutRoot, '.git'));
    const failure = new Error('lefthook executable failed to spawn');

    expect(() =>
      runLefthookInstall({
        cwd: checkoutRoot,
        runProcess() {
          return spawnResult(null, failure);
        },
        writeOutput() {},
      }),
    ).toThrow(failure);
  });

  it('propagates filesystem errors other than missing .git metadata', () => {
    const root = makeTemporaryRoot();
    const nonDirectoryCwd = join(root, 'not-a-directory');
    writeFileSync(nonDirectoryCwd, 'fixture\n', 'utf8');

    let failure;
    try {
      runLefthookInstall({
        cwd: nonDirectoryCwd,
        runProcess() {
          throw new Error('Lefthook must not run after a filesystem error');
        },
        writeOutput() {},
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({ code: 'ENOTDIR' });
  });

  it('wires the root prepare lifecycle through the guarded installer', () => {
    const packageJson = JSON.parse(readFileSync(`${repositoryRoot}/package.json`, 'utf8'));

    expect(packageJson.scripts.prepare).toBe('node scripts/install-lefthook.mjs');
  });
});
