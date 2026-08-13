import { describe, expect, it } from 'vitest';
import {
  type CommandResult,
  type CommandRunner,
  captureReviewSource,
  compareReviewSourceFreshness,
  recaptureReviewSource,
} from '../src/index.js';

const PATCH_WITH_VOUCH = [
  'diff --git a/src/example.ts b/src/example.ts',
  'index 1111111..2222222 100644',
  '--- a/src/example.ts',
  '+++ b/src/example.ts',
  '@@ -1 +1 @@',
  '-export const value = 1;',
  '+export const value = 2;',
  '',
  'diff --git a/.vouch/report.md b/.vouch/report.md',
  'index 3333333..4444444 100644',
  '--- a/.vouch/report.md',
  '+++ b/.vouch/report.md',
  '@@ -1 +1 @@',
  '-old report',
  '+new report',
  '',
].join('\n');

const PATCH = [
  'diff --git a/src/example.ts b/src/example.ts',
  'index 1111111..2222222 100644',
  '--- a/src/example.ts',
  '+++ b/src/example.ts',
  '@@ -1 +1 @@',
  '-export const value = 1;',
  '+export const value = 2;',
  '',
].join('\n');

function key(command: string, args: readonly string[]): string {
  return [command, ...args].join(' ');
}

function runner(fixtures: Record<string, string>): CommandRunner {
  return {
    run(command, args): CommandResult {
      const output = fixtures[key(command, args)];
      if (output === undefined) throw new Error(`missing fixture: ${key(command, args)}`);
      return { exitCode: 0, stdout: output, stderr: '' };
    },
  };
}

describe('excludes', () => {
  it('drops PR patch chunks matching an exclude pattern, leaving survivors byte-identical', () => {
    const commandRunner: CommandRunner = {
      run(command, args): CommandResult {
        const commandKey = key(command, args);
        if (commandKey.startsWith('gh pr view ')) {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              number: 317,
              title: 'Fixture',
              url: 'https://github.com/acme/repo/pull/317',
              baseRefOid: 'base-a',
              headRefOid: 'head-a',
            }),
            stderr: '',
          };
        }
        if (commandKey === 'gh pr diff https://github.com/acme/repo/pull/317') {
          return { exitCode: 0, stdout: PATCH_WITH_VOUCH, stderr: '' };
        }
        throw new Error(`missing fixture: ${commandKey}`);
      },
    };
    const captured = captureReviewSource({
      root: '/repo',
      runner: commandRunner,
      source: { kind: 'pr', selector: '317', excludes: ['.vouch'] },
    });
    expect(captured.eligiblePaths).toEqual(['src/example.ts']);
    expect(captured.patch).not.toContain('.vouch');
    const survivorChunk = PATCH_WITH_VOUCH.split(/(?=^diff --git )/mu)[0];
    expect(captured.patch).toBe(survivorChunk);
  });

  it('reports when an exclude pattern consumed the entire PR diff', () => {
    const onlyVouchPatch = PATCH_WITH_VOUCH.split(/(?=^diff --git )/mu)[1];
    const commandRunner: CommandRunner = {
      run(command, args): CommandResult {
        const commandKey = key(command, args);
        if (commandKey.startsWith('gh pr view ')) {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              number: 317,
              title: 'Fixture',
              url: 'https://github.com/acme/repo/pull/317',
              baseRefOid: 'base-a',
              headRefOid: 'head-a',
            }),
            stderr: '',
          };
        }
        if (commandKey === 'gh pr diff https://github.com/acme/repo/pull/317') {
          return { exitCode: 0, stdout: onlyVouchPatch, stderr: '' };
        }
        throw new Error(`missing fixture: ${commandKey}`);
      },
    };
    expect(() =>
      captureReviewSource({
        root: '/repo',
        runner: commandRunner,
        source: { kind: 'pr', selector: '317', excludes: ['.vouch'] },
      }),
    ).toThrow(/exclud/i);
  });

  it('excludes untracked files matching a user exclude pattern from unstaged capture', () => {
    const commandRunner: CommandRunner = {
      run(command, args): CommandResult {
        const commandKey = key(command, args);
        if (commandKey === 'git rev-parse HEAD') {
          return { exitCode: 0, stdout: 'abc123\n', stderr: '' };
        }
        if (commandKey.startsWith('git diff --no-ext-diff --binary --')) {
          expect(commandKey).toContain(':(exclude).vouch');
          expect(commandKey).toContain(':(exclude,glob).vouch/**');
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        if (commandKey === 'git ls-files --others --exclude-standard -z') {
          return { exitCode: 0, stdout: 'src/keep.ts\0.vouch/report.md\0', stderr: '' };
        }
        throw new Error(`missing fixture: ${commandKey}`);
      },
    };
    const captured = captureReviewSource({
      root: '/repo',
      runner: commandRunner,
      readFile: () => 'kept\n',
      source: { kind: 'unstaged', excludes: ['.vouch'] },
    });
    expect(captured.eligiblePaths).toEqual(['src/keep.ts']);
    expect(captured.patch).not.toContain('.vouch');
  });

  it('produces a different fingerprint and source identity for different excludes', () => {
    const commandRunner = runner({
      'git rev-parse HEAD': 'abc123\n',
      'git diff --cached --no-ext-diff --binary': PATCH,
    });
    const withoutExcludes = captureReviewSource({
      root: '/repo',
      runner: commandRunner,
      source: { kind: 'staged' },
    });
    const withExcludes = captureReviewSource({
      root: '/repo',
      runner: commandRunner,
      source: { kind: 'staged', excludes: ['.vouch'] },
    });
    expect(withoutExcludes.fingerprint).not.toBe(withExcludes.fingerprint);
    expect(withoutExcludes.source).not.toEqual(withExcludes.source);
    expect(withoutExcludes.source).toEqual({ kind: 'staged', headSha: 'abc123' });
  });

  it('produces the same fingerprint and source identity regardless of exclude input order', () => {
    const commandRunner = runner({
      'git rev-parse HEAD': 'abc123\n',
      'git diff --cached --no-ext-diff --binary': PATCH,
    });
    const a = captureReviewSource({
      root: '/repo',
      runner: commandRunner,
      source: { kind: 'staged', excludes: ['b', 'a'] },
    });
    const b = captureReviewSource({
      root: '/repo',
      runner: commandRunner,
      source: { kind: 'staged', excludes: ['a', 'b'] },
    });
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.source).toEqual(b.source);
  });
});

describe('review source freshness', () => {
  it.each(['staged', 'unstaged'] as const)(
    'detects unchanged and changed %s captures from the shared adapter',
    (kind) => {
      let patch = PATCH;
      const commandRunner: CommandRunner = {
        run(command, args): CommandResult {
          const commandKey = key(command, args);
          if (commandKey === 'git rev-parse HEAD') {
            return { exitCode: 0, stdout: 'abc123\n', stderr: '' };
          }
          if (
            commandKey === 'git diff --cached --no-ext-diff --binary' ||
            commandKey ===
              'git diff --no-ext-diff --binary -- :(exclude).synergy/preview.runtime.json :(exclude).synergy/preview.runtime.json.* :(exclude).synergy/.preview.runtime.json.*.tmp :(exclude).synergy/preview.start.lock :(exclude).synergy/preview.start.lock.* :(exclude).synergy/preview.pid :(exclude).synergy/preview.log'
          ) {
            return { exitCode: 0, stdout: patch, stderr: '' };
          }
          if (commandKey === 'git ls-files --others --exclude-standard -z') {
            return { exitCode: 0, stdout: '', stderr: '' };
          }
          throw new Error(`missing fixture: ${commandKey}`);
        },
      };
      const captured = captureReviewSource({
        root: '/repo',
        runner: commandRunner,
        source: { kind },
      });

      expect(compareReviewSourceFreshness(captured, '/repo', { runner: commandRunner })).toEqual({
        sourceChanged: false,
        captureFailed: false,
      });

      patch = PATCH.replace('value = 2', 'value = 3');
      expect(compareReviewSourceFreshness(captured, '/repo', { runner: commandRunner })).toEqual({
        sourceChanged: true,
        captureFailed: false,
      });
    },
  );

  it('detects unchanged and changed scoped captures', () => {
    let content = 'export const value = 1;\n';
    const commandRunner = runner({
      'git rev-parse HEAD': 'abc123\n',
      'git ls-files --cached --others --exclude-standard -z -- src': 'src/example.ts\0',
    });
    const captured = captureReviewSource({
      root: '/repo',
      runner: commandRunner,
      readFile: () => content,
      source: { kind: 'scope', patterns: ['src'] },
    });

    expect(
      compareReviewSourceFreshness(captured, '/repo', {
        runner: commandRunner,
        readFile: () => content,
      }),
    ).toEqual({ sourceChanged: false, captureFailed: false });

    content = 'export const value = 2;\n';
    expect(
      compareReviewSourceFreshness(captured, '/repo', {
        runner: commandRunner,
        readFile: () => content,
      }),
    ).toEqual({ sourceChanged: true, captureFailed: false });
  });

  it('recaptures a PR by its immutable canonical URL and detects head changes', () => {
    let headSha = 'head-a';
    const commandRunner: CommandRunner = {
      run(command, args): CommandResult {
        const commandKey = key(command, args);
        if (commandKey.startsWith('gh pr view ')) {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              number: 317,
              title: 'Fixture',
              url: 'https://github.com/acme/repo/pull/317',
              baseRefOid: 'base-a',
              headRefOid: headSha,
            }),
            stderr: '',
          };
        }
        if (commandKey === 'gh pr diff https://github.com/acme/repo/pull/317') {
          return { exitCode: 0, stdout: PATCH, stderr: '' };
        }
        throw new Error(`missing fixture: ${commandKey}`);
      },
    };
    const captured = captureReviewSource({
      root: '/repo',
      runner: commandRunner,
      source: { kind: 'pr', selector: '317' },
    });

    expect(
      recaptureReviewSource(captured.source, '/repo', { runner: commandRunner }).source,
    ).toEqual(captured.source);
    expect(compareReviewSourceFreshness(captured, '/repo', { runner: commandRunner })).toEqual({
      sourceChanged: false,
      captureFailed: false,
    });

    headSha = 'head-b';
    expect(compareReviewSourceFreshness(captured, '/repo', { runner: commandRunner })).toEqual({
      sourceChanged: true,
      captureFailed: false,
    });
  });

  it('fails freshness closed when recapture cannot be completed', () => {
    const commandRunner: CommandRunner = {
      run(): CommandResult {
        return { exitCode: 1, stdout: '', stderr: 'fatal: unavailable' };
      },
    };

    expect(
      compareReviewSourceFreshness(
        { source: { kind: 'staged', headSha: 'abc123' }, fingerprint: 'old' },
        '/repo',
        { runner: commandRunner },
      ),
    ).toEqual({ sourceChanged: true, captureFailed: true });
  });
});
