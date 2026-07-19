import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type CommandResult,
  type CommandRunner,
  capturePr,
  captureReviewSource,
  captureScope,
  captureUnstaged,
} from './review-capture.js';

const TRACKED_PATCH = [
  'diff --git a/src/existing.ts b/src/existing.ts',
  'index 1111111..2222222 100644',
  '--- a/src/existing.ts',
  '+++ b/src/existing.ts',
  '@@ -1 +1 @@',
  '-export const value = 1;',
  '+export const value = 2;',
  '',
].join('\n');

const UNSTAGED_DIFF_COMMAND =
  'git diff --no-ext-diff --binary -- :(exclude).synergy/preview.runtime.json :(exclude).synergy/preview.runtime.json.* :(exclude).synergy/.preview.runtime.json.*.tmp :(exclude).synergy/preview.start.lock :(exclude).synergy/preview.start.lock.* :(exclude).synergy/preview.pid :(exclude).synergy/preview.log';

function commandKey(command: string, args: readonly string[]): string {
  return [command, ...args].join(' ');
}

function createFixtureRunner(
  fixtures: Record<string, string | Partial<CommandResult>>,
): CommandRunner {
  return {
    run(command, args): CommandResult {
      const fixture = fixtures[commandKey(command, args)];
      if (fixture === undefined) {
        throw new Error(`missing fixture for ${commandKey(command, args)}`);
      }
      if (typeof fixture === 'string') return { exitCode: 0, stdout: fixture, stderr: '' };
      return { exitCode: 0, stdout: '', stderr: '', ...fixture };
    },
  };
}

describe('review source capture', () => {
  const temporaryRoots: string[] = [];

  afterEach(() => {
    for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  });
  it('captures unstaged tracked and non-ignored untracked files', () => {
    const runner = createFixtureRunner({
      [UNSTAGED_DIFF_COMMAND]: TRACKED_PATCH,
      'git ls-files --others --exclude-standard -z':
        'src/new.ts\0.synergy/preview.runtime.json\0.synergy/preview.start.lock.quarantine.attempt\0',
    });

    const result = captureUnstaged({
      root: '/repo',
      runner,
      readFile: () => 'export const x = 1;\n',
    });

    expect(result.patch).toContain('src/new.ts');
    expect(result.eligiblePaths).toContain('src/new.ts');
    expect(result.eligiblePaths).toContain('src/existing.ts');
    expect(result.eligiblePaths).not.toContain('node_modules/pkg/index.js');
    expect(result.eligiblePaths).not.toContain('.synergy/preview.runtime.json');
  });

  it('excludes tracked and untracked preview control artifacts from an existing project', () => {
    const root = join(tmpdir(), `synergy-review-runtime-artifacts-${Date.now()}`);
    temporaryRoots.push(root);
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(join(root, '.synergy'), { recursive: true });
    writeFileSync(join(root, 'src/app.ts'), 'export const value = 1;\n');
    writeFileSync(join(root, '.synergy/preview.runtime.json'), '{"controlToken":"old-secret"}\n');
    execFileSync('git', ['init', '--quiet'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'review@example.test'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Review Test'], { cwd: root });
    execFileSync('git', ['add', '--', 'src/app.ts', '.synergy/preview.runtime.json'], {
      cwd: root,
    });
    execFileSync('git', ['commit', '--quiet', '-m', 'baseline'], { cwd: root });
    writeFileSync(join(root, 'src/app.ts'), 'export const value = 2;\n');
    writeFileSync(join(root, '.synergy/preview.runtime.json'), '{"controlToken":"new-secret"}\n');
    writeFileSync(join(root, '.synergy/preview.start.lock'), '{"pid":123}\n');

    const result = captureUnstaged({ root });

    expect(result.eligiblePaths).toEqual(['src/app.ts']);
    expect(result.patch).not.toContain('controlToken');
    expect(result.patch).not.toContain('preview.start.lock');
  });

  it('keeps spaces in NUL-delimited untracked paths', () => {
    const runner = createFixtureRunner({
      [UNSTAGED_DIFF_COMMAND]: '',
      'git ls-files --others --exclude-standard -z': 'src/new file.ts\0',
    });

    const result = captureUnstaged({ root: '/repo', runner, readFile: () => 'export {};\n' });

    expect(result.eligiblePaths).toEqual(['src/new file.ts']);
    expect(result.patch).toContain('src/new file.ts');
  });

  it('preserves a newline in a NUL-delimited untracked filename', () => {
    const path = 'src/new\nfile.ts';
    const runner = createFixtureRunner({
      [UNSTAGED_DIFF_COMMAND]: '',
      'git ls-files --others --exclude-standard -z': `${path}\0`,
    });

    const result = captureUnstaged({ root: '/repo', runner, readFile: () => 'export {};\n' });

    expect(result.eligiblePaths).toEqual([path]);
    expect(result.patch).toContain('"a/src/new\\nfile.ts"');
  });

  it('rejects raw non-UTF-8 Git path bytes without replacement corruption', () => {
    const runner: CommandRunner = {
      run(command, args): CommandResult {
        const key = commandKey(command, args);
        if (key === UNSTAGED_DIFF_COMMAND) {
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        if (key === 'git ls-files --others --exclude-standard -z') {
          return {
            exitCode: 0,
            stdout: Buffer.from([0x73, 0x72, 0x63, 0x2f, 0xff, 0]),
            stderr: '',
          };
        }
        throw new Error(`missing fixture for ${key}`);
      },
    };

    expect(() => captureUnstaged({ root: '/repo', runner, readFile: () => 'export {};' })).toThrow(
      /non-UTF-8 repository path/i,
    );
  });

  it('accepts a valid UTF-8 path containing the replacement-character glyph', () => {
    const path = 'src/�.ts';
    const runner: CommandRunner = {
      run(command, args): CommandResult {
        const key = commandKey(command, args);
        if (key === UNSTAGED_DIFF_COMMAND) {
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        if (key === 'git ls-files --others --exclude-standard -z') {
          return { exitCode: 0, stdout: Buffer.from(`${path}\0`, 'utf8'), stderr: '' };
        }
        throw new Error(`missing fixture for ${key}`);
      },
    };

    expect(
      captureUnstaged({ root: '/repo', runner, readFile: () => 'export {};' }).eligiblePaths,
    ).toEqual([path]);
  });

  it('rejects a binary-only scope without creating text sections', () => {
    const runner = createFixtureRunner({
      'git ls-files --cached --others --exclude-standard -z -- src': 'src/logo.png\0',
    });

    expect(() =>
      captureScope({
        root: '/repo',
        patterns: ['src'],
        runner,
        readFile: () => 'a\0b',
      }),
    ).toThrow(/binary/i);
  });

  it('fingerprints exact scoped file contents after resolving the Git head', () => {
    const runner = createFixtureRunner({
      'git ls-files --cached --others --exclude-standard -z -- src': 'src/example.ts\0',
      'git rev-parse HEAD': 'abc123\n',
    });
    let content = 'export const value = 1;\n';
    const request = {
      root: '/repo',
      runner,
      readFile: () => content,
      source: { kind: 'scope' as const, patterns: ['src'] },
    };

    const initial = captureReviewSource(request);
    content = 'export const value = 2;\n';

    expect(captureReviewSource(request).fingerprint).not.toBe(initial.fingerprint);
  });

  it('reports GitHub authentication failures with a corrective action', () => {
    const runner = createFixtureRunner({
      'gh pr view 317 --json number,title,url,baseRefOid,headRefOid': {
        exitCode: 1,
        stderr: 'To get started with GitHub CLI, please run: gh auth login',
      },
    });

    expect(() => capturePr({ root: '/repo', selector: '317', runner })).toThrow(/gh auth login/i);
  });

  it('uses the canonical PR URL and matching metadata around the captured patch', () => {
    const calls: string[] = [];
    const runner: CommandRunner = {
      run(command, args): CommandResult {
        const key = commandKey(command, args);
        calls.push(key);
        if (key === 'gh pr view 317 --json number,title,url,baseRefOid,headRefOid') {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              number: 317,
              title: 'Review fixture',
              url: 'https://github.com/acme/repo/pull/317',
              baseRefOid: 'base',
              headRefOid: 'head',
            }),
            stderr: '',
          };
        }
        if (key === 'gh pr diff https://github.com/acme/repo/pull/317 --patch') {
          return { exitCode: 0, stdout: TRACKED_PATCH, stderr: '' };
        }
        if (
          key ===
          'gh pr view https://github.com/acme/repo/pull/317 --json number,title,url,baseRefOid,headRefOid'
        ) {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              number: 317,
              title: 'Review fixture',
              url: 'https://github.com/acme/repo/pull/317',
              baseRefOid: 'base',
              headRefOid: 'head',
            }),
            stderr: '',
          };
        }
        throw new Error(`missing fixture for ${key}`);
      },
    };

    const result = capturePr({ root: '/repo', selector: '317', runner });

    expect(result.source).toMatchObject({ url: 'https://github.com/acme/repo/pull/317' });
    expect(calls).toEqual([
      'gh pr view 317 --json number,title,url,baseRefOid,headRefOid',
      'gh pr diff https://github.com/acme/repo/pull/317 --patch',
      'gh pr view https://github.com/acme/repo/pull/317 --json number,title,url,baseRefOid,headRefOid',
    ]);
  });

  it('fingerprints different binary bytes at the same untracked path', () => {
    const runner = createFixtureRunner({
      [UNSTAGED_DIFF_COMMAND]: '',
      'git ls-files --others --exclude-standard -z': 'assets/logo.bin\0',
    });
    let content = 'one\0binary';
    const first = captureUnstaged({ root: '/repo', runner, readFile: () => content });
    content = 'two\0binary';

    expect(
      captureUnstaged({ root: '/repo', runner, readFile: () => content }).fingerprint,
    ).not.toBe(first.fingerprint);
  });

  it('rejects an outward-pointing symlink without reading its target', () => {
    const root = join(tmpdir(), `synergy-review-link-${Date.now()}`);
    temporaryRoots.push(root);
    mkdirSync(join(root, 'src'), { recursive: true });
    const outside = join(tmpdir(), `synergy-review-secret-${Date.now()}`);
    temporaryRoots.push(outside);
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'secret.ts'), 'export const secret = true;\n');
    symlinkSync(join(outside, 'secret.ts'), join(root, 'src', 'leak.ts'));
    const runner = createFixtureRunner({
      'git ls-files --cached --others --exclude-standard -z -- src': 'src/leak.ts\0',
    });

    expect(() => captureScope({ root, patterns: ['src'], runner })).toThrow(/symbolic link/i);
  });

  it('rejects an outward-pointing symlink in an ancestor directory', () => {
    const root = join(tmpdir(), `synergy-review-ancestor-link-${Date.now()}`);
    temporaryRoots.push(root);
    const outside = join(tmpdir(), `synergy-review-ancestor-secret-${Date.now()}`);
    temporaryRoots.push(outside);
    mkdirSync(root, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'secret.ts'), 'export const secret = true;\n');
    symlinkSync(outside, join(root, 'src'));
    const runner = createFixtureRunner({
      'git ls-files --cached --others --exclude-standard -z -- src': 'src/secret.ts\0',
    });

    expect(() => captureScope({ root, patterns: ['src'], runner })).toThrow(/symbolic link/i);
  });

  it('preserves executable mode and an empty untracked file without inventing a content line', () => {
    const root = join(tmpdir(), `synergy-review-mode-${Date.now()}`);
    temporaryRoots.push(root);
    mkdirSync(join(root, 'bin'), { recursive: true });
    writeFileSync(join(root, 'bin', 'run'), 'echo hi\n');
    chmodSync(join(root, 'bin', 'run'), 0o755);
    writeFileSync(join(root, 'empty.txt'), '');
    const runner = createFixtureRunner({
      [UNSTAGED_DIFF_COMMAND]: '',
      'git ls-files --others --exclude-standard -z': 'bin/run\0empty.txt\0',
    });

    const result = captureUnstaged({ root, runner });

    expect(result.patch).toContain('new file mode 100755');
    expect(result.patch).toContain('+++ "b/empty.txt"');
    expect(result.patch).not.toContain('@@ -0,0 +1,1 @@\n+\n');
  });

  it('treats invalid UTF-8 bytes without NUL as binary scope content', () => {
    const root = join(tmpdir(), `synergy-review-utf8-${Date.now()}`);
    temporaryRoots.push(root);
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'invalid.bin'), Buffer.from([0xc3, 0x28]));
    const runner = createFixtureRunner({
      'git ls-files --cached --others --exclude-standard -z -- src': 'src/invalid.bin\0',
    });

    expect(() => captureScope({ root, patterns: ['src'], runner })).toThrow(/binary/i);
  });

  it('normalizes equivalent scope spellings before Git capture and fingerprinting', () => {
    const runner = createFixtureRunner({
      'git ls-files --cached --others --exclude-standard -z -- src': 'src/example.ts\0',
    });
    const canonical = captureScope({
      root: '/repo',
      patterns: ['src'],
      runner,
      readFile: () => 'export const value = 1;\n',
    });
    const equivalent = captureScope({
      root: '/repo',
      patterns: ['././src/', 'src'],
      runner,
      readFile: () => 'export const value = 1;\n',
    });

    expect(equivalent.source).toEqual(canonical.source);
    expect(equivalent.fingerprint).toBe(canonical.fingerprint);
  });

  it('retries local capture once when HEAD changes and fails when it keeps drifting', () => {
    const heads = ['one', 'two', 'three', 'four'];
    const runner: CommandRunner = {
      run(command, args): CommandResult {
        const key = commandKey(command, args);
        if (key === 'git rev-parse HEAD') {
          const head = heads.shift();
          if (!head) throw new Error('missing HEAD fixture');
          return { exitCode: 0, stdout: `${head}\n`, stderr: '' };
        }
        if (key === 'git diff --cached --no-ext-diff --binary') {
          return { exitCode: 0, stdout: TRACKED_PATCH, stderr: '' };
        }
        throw new Error(`missing fixture for ${key}`);
      },
    };

    expect(() =>
      captureReviewSource({ root: '/repo', runner, source: { kind: 'staged' } }),
    ).toThrow(/HEAD changed/i);
  });

  it('uses the stable second local capture after a single HEAD drift', () => {
    const heads = ['one', 'two', 'three', 'three'];
    const runner: CommandRunner = {
      run(command, args): CommandResult {
        const key = commandKey(command, args);
        if (key === 'git rev-parse HEAD') {
          const head = heads.shift();
          if (!head) throw new Error('missing HEAD fixture');
          return { exitCode: 0, stdout: `${head}\n`, stderr: '' };
        }
        if (key === 'git diff --cached --no-ext-diff --binary') {
          return { exitCode: 0, stdout: TRACKED_PATCH, stderr: '' };
        }
        throw new Error(`missing fixture for ${key}`);
      },
    };

    expect(
      captureReviewSource({ root: '/repo', runner, source: { kind: 'staged' } }).source,
    ).toMatchObject({ headSha: 'three' });
  });
});
