import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runLefthookInstall } from '../../../scripts/install-lefthook.mjs';

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));

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
  it('skips installation outside a Git checkout', () => {
    const calls = [];
    let output = '';

    const exitCode = runLefthookInstall({
      cwd: '/archive',
      runProcess(command, args, options) {
        calls.push({ command, args, options });
        return spawnResult(128);
      },
      writeOutput(message) {
        output += message;
      },
    });

    expect(exitCode).toBe(0);
    expect(calls).toEqual([
      {
        command: 'git',
        args: ['rev-parse', '--git-dir'],
        options: { cwd: '/archive', stdio: 'ignore' },
      },
    ]);
    expect(output).toBe('Skipping lefthook install: not a Git checkout.\n');
  });

  it('invokes lefthook in a Git checkout', () => {
    const calls = [];

    const exitCode = runLefthookInstall({
      cwd: '/checkout',
      runProcess(command, args, options) {
        calls.push({ command, args, options });
        return spawnResult(0);
      },
      writeOutput() {},
    });

    expect(exitCode).toBe(0);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({
      command: 'git',
      args: ['rev-parse', '--git-dir'],
      options: { cwd: '/checkout', stdio: 'ignore' },
    });
    expect(calls[1]?.command).toBe(process.execPath);
    expect(calls[1]?.args[0]).toMatch(/node_modules[/\\]lefthook[/\\]bin[/\\]index\.js$/u);
    expect(calls[1]?.args[1]).toBe('install');
    expect(calls[1]?.options).toEqual({ cwd: '/checkout', stdio: 'inherit' });
  });

  it('propagates a lefthook installation failure', () => {
    let invocation = 0;

    const exitCode = runLefthookInstall({
      cwd: '/checkout',
      runProcess() {
        invocation += 1;
        return spawnResult(invocation === 1 ? 0 : 23);
      },
      writeOutput() {},
    });

    expect(exitCode).toBe(23);
  });

  it('does not mask a process-spawn error', () => {
    const failure = new Error('lefthook executable failed to spawn');
    let invocation = 0;

    expect(() =>
      runLefthookInstall({
        cwd: '/checkout',
        runProcess() {
          invocation += 1;
          return spawnResult(invocation === 1 ? 0 : null, invocation === 1 ? undefined : failure);
        },
        writeOutput() {},
      }),
    ).toThrow(failure);
  });

  it('wires the root prepare lifecycle through the guarded installer', () => {
    const packageJson = JSON.parse(readFileSync(`${repositoryRoot}/package.json`, 'utf8'));

    expect(packageJson.scripts.prepare).toBe('node scripts/install-lefthook.mjs');
  });
});
