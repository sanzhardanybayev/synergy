import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import cac from 'cac';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createReviewSourceFromFlags,
  registerReviewCommands,
  runReviewWaitCommand,
} from './review-cli.js';

interface CliResult {
  exitCode: number | undefined;
  stdout: string;
  stderr: string;
}

function runReviewCli(args: string[]): CliResult {
  const cli = cac('synergy');
  registerReviewCommands(cli);
  const stdout: string[] = [];
  const stderr: string[] = [];
  const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout.push(String(chunk));
    return true;
  });
  const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr.push(String(chunk));
    return true;
  });
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    cli.parse(['node', 'synergy', 'review', ...args]);
    return { exitCode: process.exitCode, stdout: stdout.join(''), stderr: stderr.join('') };
  } finally {
    process.exitCode = previousExitCode;
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  }
}

describe('review CLI source flags', () => {
  const temporaryRoots: string[] = [];

  afterEach(() => {
    for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  });
  it('requires exactly one source selector', () => {
    expect(() => createReviewSourceFromFlags({ staged: true, unstaged: true })).toThrow(
      /exactly one/i,
    );
    expect(() => createReviewSourceFromFlags({})).toThrow(/exactly one/i);
  });

  it('maps a scope selector to a repository-relative capture request', () => {
    expect(createReviewSourceFromFlags({ scope: 'src/features' })).toEqual({
      kind: 'scope',
      patterns: ['src/features'],
    });
  });

  it('rejects invalid usage before attempting Git root resolution', () => {
    const root = mkdtempSync(join(tmpdir(), 'synergy-review-cli-body-'));
    temporaryRoots.push(root);
    const malformedBody = join(root, 'invalid.json');
    writeFileSync(malformedBody, '{invalid', 'utf8');
    const cases = [
      ['create', 'unexpected', '--staged', '--root', '/not-a-repository'],
      [
        'analysis-set',
        'workspace@revision',
        '--body-file',
        malformedBody,
        '--root',
        '/not-a-repository',
      ],
      ['analysis-set', 'workspace@revision', '--json', '--body-file', malformedBody],
      ['refresh', '../invalid', '--root', '/not-a-repository'],
      ['status', 'malformed-reference', '--root', '/not-a-repository'],
      ['wait', 'workspace@revision', '--for', 'not-a-duration', '--root', '/not-a-repository'],
      ['answer', 'question-1', '--review', 'workspace@revision', '--root', '/not-a-repository'],
      ['list', '--unknown-option', '--root', '/not-a-repository'],
      ['unknown-action', '--root', '/not-a-repository'],
    ];

    for (const args of cases) {
      const result = runReviewCli(args);
      expect(result.exitCode).toBe(2);
      expect(result.stdout).toBe('');
      expect(result.stderr).toMatch(/Error:/);
      expect(result.stderr).not.toMatch(/Git capture|repository root/i);
    }
  });

  it('executes list through CAC from a nested directory using the canonical Git root', () => {
    const root = mkdtempSync(join(tmpdir(), 'synergy-review-cli-'));
    temporaryRoots.push(root);
    const nested = join(root, 'src', 'nested');
    mkdirSync(nested, { recursive: true });
    execFileSync('git', ['init', '--quiet', root]);

    const result = runReviewCli(['list', '--root', nested, '--json']);

    expect(result.exitCode).toBeUndefined();
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual([]);
  });

  it('removes direct wait signal handlers after success and failure', async () => {
    const initialInterruptListeners = process.listenerCount('SIGINT');
    const initialTerminateListeners = process.listenerCount('SIGTERM');
    const base = {
      root: '/repository',
      reference: { workspaceId: 'workspace', revisionId: 'revision' },
      listenerId: 'listener-1',
    };

    await runReviewWaitCommand({
      ...base,
      wait: async () => ({ status: 'timeout', listenerId: 'listener-1', questions: [] }),
    });
    expect(process.listenerCount('SIGINT')).toBe(initialInterruptListeners);
    expect(process.listenerCount('SIGTERM')).toBe(initialTerminateListeners);

    await expect(
      runReviewWaitCommand({
        ...base,
        wait: async () => {
          throw new Error('wait failed');
        },
      }),
    ).rejects.toThrow('wait failed');
    expect(process.listenerCount('SIGINT')).toBe(initialInterruptListeners);
    expect(process.listenerCount('SIGTERM')).toBe(initialTerminateListeners);
  });
});
