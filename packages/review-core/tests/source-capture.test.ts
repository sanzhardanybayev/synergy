import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type CommandResult,
  type CommandRunner,
  captureReviewSource,
  captureScope,
  captureStaged,
  captureUnstaged,
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

const temporaryRoots: string[] = [];

function makeWildcardExcludeRepository(): string {
  const root = join(tmpdir(), `synergy-review-exclude-glob-${Date.now()}-${Math.random()}`);
  temporaryRoots.push(root);
  mkdirSync(join(root, 'nested'), { recursive: true });
  writeFileSync(join(root, 'debug.log'), 'tracked-top-v1\n');
  writeFileSync(join(root, 'nested/debug.log'), 'tracked-nested-v1\n');
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'review@example.test'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Review Test'], { cwd: root });
  execFileSync('git', ['add', 'debug.log', 'nested/debug.log'], { cwd: root });
  execFileSync('git', ['commit', '--quiet', '-m', 'baseline'], { cwd: root });
  // Tracked, modified-but-unstaged changes to both the top-level and nested `*.log` files.
  writeFileSync(join(root, 'debug.log'), 'tracked-top-v2\n');
  writeFileSync(join(root, 'nested/debug.log'), 'tracked-nested-v2\n');
  // Untracked `*.log` files at both levels.
  writeFileSync(join(root, 'extra.log'), 'untracked-top\n');
  writeFileSync(join(root, 'nested/extra.log'), 'untracked-nested\n');
  return root;
}

function initRepository(prefix: string): string {
  const root = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random()}`);
  temporaryRoots.push(root);
  mkdirSync(root, { recursive: true });
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'review@example.test'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Review Test'], { cwd: root });
  return root;
}

function git(root: string, ...args: string[]): void {
  execFileSync('git', args, { cwd: root });
}

// Module-scoped so every describe block below that creates a real repository (not just the one
// named after it) gets its temp directory cleaned up.
afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('exclude semantics against real git (not the fixture runner)', () => {
  it('keeps a file renamed OUT of an excluded directory in the review (C1 regression)', () => {
    const root = initRepository('synergy-review-exclude-rename-out');
    mkdirSync(join(root, '.vouch'), { recursive: true });
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, '.vouch', 'r.ts'), 'export const r = 1;\n');
    writeFileSync(join(root, 'src', 'keep.ts'), 'export const keep = 1;\n');
    git(root, 'add', '.');
    git(root, 'commit', '--quiet', '-m', 'base');

    // Rename a file OUT of the excluded directory into reviewed source, and touch an unrelated
    // reviewed file so the staged diff has more than one chunk (matching the reported repro).
    git(root, 'mv', '.vouch/r.ts', 'src/moved.ts');
    writeFileSync(join(root, 'src', 'keep.ts'), 'export const keep = 2;\n');
    git(root, 'add', '.');

    const result = captureStaged({ root, excludes: ['.vouch'] });

    // The destination now lives in reviewed source and was never itself named by the exclude
    // pattern - it must survive. Gating on `previousPath` too (the pre-fix behavior) silently
    // dropped it because the file's OLD path matched `.vouch`.
    expect(result.eligiblePaths).toEqual(['src/keep.ts', 'src/moved.ts']);
    expect(result.patch).toContain('src/moved.ts');
  });

  it('still drops a file renamed INTO an excluded directory', () => {
    const root = initRepository('synergy-review-exclude-rename-in');
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(join(root, '.vouch'), { recursive: true });
    writeFileSync(join(root, 'src', 'move-me.ts'), 'export const m = 1;\n');
    writeFileSync(join(root, 'src', 'keep.ts'), 'export const keep = 1;\n');
    git(root, 'add', '.');
    git(root, 'commit', '--quiet', '-m', 'base');

    git(root, 'mv', 'src/move-me.ts', '.vouch/moved.ts');
    writeFileSync(join(root, 'src', 'keep.ts'), 'export const keep = 2;\n');
    git(root, 'add', '.');

    const result = captureStaged({ root, excludes: ['.vouch'] });

    expect(result.eligiblePaths).toEqual(['src/keep.ts']);
    expect(result.patch).not.toContain('.vouch');
  });

  it('gives captureUnstaged the same *.log answer for tracked and untracked nested matches', () => {
    const root = makeWildcardExcludeRepository();

    const result = captureUnstaged({ root, excludes: ['*.log'] });

    // Top-level debug.log/extra.log (tracked-modified and untracked) are excluded; the nested
    // copies are NOT, because `*` is single-segment - it must not cross a `/` at either the git
    // pathspec level (tracked diff) or the JS ls-files filter level (untracked listing).
    expect(result.eligiblePaths).toEqual(['nested/debug.log', 'nested/extra.log']);
    expect(result.patch).not.toMatch(/^diff --git a\/debug\.log/mu);
    expect(result.patch).not.toMatch(/^diff --git a\/extra\.log/mu);
  });

  it('gives captureScope the same *.log answer as captureUnstaged for nested matches', () => {
    const root = makeWildcardExcludeRepository();

    const result = captureScope({
      root,
      patterns: ['debug.log', 'extra.log', 'nested'],
      excludes: ['*.log'],
    });

    expect(result.eligiblePaths).toEqual(['nested/debug.log', 'nested/extra.log']);
  });
});

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

  // NOTE: this used to run against a fixture runner with a WILDCARD pattern (`**/*.log`). That
  // pattern never becomes a git pathspec (see `excludePathspecs`), so the fixture only exercised
  // the JS-filter path. A wildcard-FREE pattern - the case that actually matters, since it takes
  // the pathspec route and reached `captureScope`'s pathspec-optimized `ls-files` call before the
  // JS filter ever runs - would have changed the fixture's command key and never matched,
  // silently passing regardless of whether the underlying diagnosis logic was correct (I5). A
  // real repository exercises the actual pathspec route.
  it('reports precisely when a wildcard-free exclude pattern consumed the entire scope', () => {
    const root = initRepository('synergy-review-exclude-scope-everything');
    mkdirSync(join(root, '.vouch'), { recursive: true });
    writeFileSync(join(root, '.vouch', 'a.md'), 'a\n');
    git(root, 'add', '.');
    git(root, 'commit', '--quiet', '-m', 'base');

    expect(() =>
      captureScope({
        root,
        patterns: ['.vouch'],
        excludes: ['.vouch'],
        readFile: () => 'a\n',
      }),
    ).toThrow(/exclud/i);
  });

  it('keeps the generic message when a scope has no files for reasons other than excludes', () => {
    const commandRunner = runner({
      'git rev-parse HEAD': 'abc123\n',
      'git ls-files --cached --others --exclude-standard -z -- src': '',
    });
    expect(() =>
      captureReviewSource({
        root: '/repo',
        runner: commandRunner,
        source: { kind: 'scope', patterns: ['src'] },
      }),
    ).toThrow(/choose a different path/i);
  });

  it('excludes untracked files matching a user exclude pattern from unstaged capture', () => {
    const commandRunner: CommandRunner = {
      run(command, args): CommandResult {
        const commandKey = key(command, args);
        if (commandKey === 'git rev-parse HEAD') {
          return { exitCode: 0, stdout: 'abc123\n', stderr: '' };
        }
        if (commandKey.startsWith('git diff --name-only -z --no-ext-diff --binary --')) {
          // The pathspec-free ground-truth enumeration `captureUnstaged` uses to compute
          // `excludedFileCount` accurately (I1) - no tracked files changed in this fixture.
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        if (commandKey.startsWith('git diff --no-ext-diff --binary --')) {
          expect(commandKey).toContain(':(exclude,literal).vouch');
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
    expect(captured.excludedFileCount).toBe(1);
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

describe('excludedFileCount accuracy against real git (I1 regression)', () => {
  it('counts every unstaged file a pathspec removed, tracked and untracked alike', () => {
    const root = initRepository('synergy-review-exclude-unstaged-count');
    mkdirSync(join(root, '.vouch'), { recursive: true });
    writeFileSync(join(root, '.vouch', 'tracked.md'), 'v1\n');
    writeFileSync(join(root, 'src.ts'), 'export const v = 1;\n');
    git(root, 'add', '.');
    git(root, 'commit', '--quiet', '-m', 'base');

    // One tracked-modified file and one untracked file under the excluded directory: the
    // wildcard-free `.vouch` pattern removes the tracked one at the git pathspec level, before
    // `filterPatch` ever sees it, so a count derived only from the (already-filtered) patch
    // undercounts by exactly the tracked half.
    writeFileSync(join(root, '.vouch', 'tracked.md'), 'v2\n');
    writeFileSync(join(root, '.vouch', 'untracked.md'), 'new\n');
    writeFileSync(join(root, 'src.ts'), 'export const v = 2;\n');

    const result = captureUnstaged({ root, excludes: ['.vouch'] });

    expect(result.eligiblePaths).toEqual(['src.ts']);
    expect(result.excludedFileCount).toBe(2);
  });

  it('counts a scoped file a wildcard-free pathspec removed, not just JS-filtered survivors', () => {
    const root = initRepository('synergy-review-exclude-scope-count');
    mkdirSync(join(root, '.vouch'), { recursive: true });
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, '.vouch', 'a.md'), 'a\n');
    writeFileSync(join(root, 'src', 'keep.ts'), 'export const keep = 1;\n');
    git(root, 'add', '.');
    git(root, 'commit', '--quiet', '-m', 'base');

    const result = captureScope({
      root,
      patterns: ['.vouch', 'src'],
      excludes: ['.vouch'],
      readFile: () => 'export const keep = 1;\n',
    });

    expect(result.eligiblePaths).toEqual(['src/keep.ts']);
    expect(result.excludedFileCount).toBe(1);
  });
});

describe('"excludes removed everything" diagnosis against real git (I2 regression)', () => {
  it('names --exclude as the cause when only excluded unstaged changes exist', () => {
    const root = initRepository('synergy-review-exclude-unstaged-everything');
    mkdirSync(join(root, '.vouch'), { recursive: true });
    writeFileSync(join(root, '.vouch', 'r.ts'), 'v1\n');
    git(root, 'add', '.');
    git(root, 'commit', '--quiet', '-m', 'base');
    writeFileSync(join(root, '.vouch', 'r.ts'), 'v2\n');

    expect(() => captureUnstaged({ root, excludes: ['.vouch'] })).toThrow(/exclud/i);
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
