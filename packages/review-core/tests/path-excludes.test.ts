import { describe, expect, it } from 'vitest';
import { excludePathspecs, isPathExcluded, normalizeExcludes } from '../src/index.js';

describe('normalizeExcludes', () => {
  it('dedupes, sorts, and collapses trailing slashes', () => {
    expect(normalizeExcludes(['.vouch/', '.vouch', 'b', 'a'])).toEqual(['.vouch', 'a', 'b']);
  });

  it('is idempotent', () => {
    const once = normalizeExcludes(['.vouch/', '.vouch']);
    expect(normalizeExcludes(once)).toEqual(once);
  });

  it('strips a leading ./', () => {
    expect(normalizeExcludes(['./.lavish'])).toEqual(['.lavish']);
  });

  it('rejects absolute paths', () => {
    expect(() => normalizeExcludes(['/etc/passwd'])).toThrow();
  });

  it('rejects windows-style absolute paths', () => {
    expect(() => normalizeExcludes(['\\etc\\passwd'])).toThrow();
  });

  it('rejects windows drive-letter absolute paths', () => {
    expect(() => normalizeExcludes(['C:\\Windows\\file'])).toThrow();
    expect(() => normalizeExcludes(['C:/Windows/file'])).toThrow();
  });

  it('rejects .. segments', () => {
    expect(() => normalizeExcludes(['../secrets'])).toThrow();
    expect(() => normalizeExcludes(['a/../b'])).toThrow();
  });

  it('rejects empty or whitespace-only input', () => {
    expect(() => normalizeExcludes([''])).toThrow();
    expect(() => normalizeExcludes(['   '])).toThrow();
  });

  it('rejects NUL bytes', () => {
    expect(() => normalizeExcludes(['a\0b'])).toThrow();
  });

  it('rejects git pathspec magic', () => {
    expect(() => normalizeExcludes([':(exclude)foo'])).toThrow();
    expect(() => normalizeExcludes([':foo'])).toThrow();
  });

  it('returns an empty array for an empty input', () => {
    expect(normalizeExcludes([])).toEqual([]);
  });

  it('normalizes backslash separators instead of silently matching nothing', () => {
    // Before the fix, a backslash-separated pattern passed the safety checks unchanged, then
    // compiled to a regex matching a literal `\` character - which no repository-relative path
    // (this matcher is POSIX-only) ever contains, so the pattern excluded nothing at all.
    expect(normalizeExcludes(['.vouch\\sub'])).toEqual(['.vouch/sub']);
    const excludes = normalizeExcludes(['.vouch\\sub']);
    expect(isPathExcluded('.vouch/sub/file.ts', excludes)).toBe(true);
  });
});

describe('isPathExcluded', () => {
  it('excludes a directory and everything beneath it', () => {
    const excludes = normalizeExcludes(['.vouch']);
    expect(isPathExcluded('.vouch', excludes)).toBe(true);
    expect(isPathExcluded('.vouch/report.md', excludes)).toBe(true);
    expect(isPathExcluded('.vouch/nested/deep.md', excludes)).toBe(true);
  });

  it('does not match a sibling that shares a prefix', () => {
    const excludes = normalizeExcludes(['.vouch']);
    expect(isPathExcluded('.vouchx/file.ts', excludes)).toBe(false);
    expect(isPathExcluded('.vouch-extra', excludes)).toBe(false);
  });

  it('supports single-segment * globs', () => {
    const excludes = normalizeExcludes(['*.log']);
    expect(isPathExcluded('debug.log', excludes)).toBe(true);
    expect(isPathExcluded('nested/debug.log', excludes)).toBe(false);
  });

  it('supports ** to cross directory boundaries', () => {
    const excludes = normalizeExcludes(['**/*.log']);
    expect(isPathExcluded('debug.log', excludes)).toBe(true);
    expect(isPathExcluded('nested/deep/debug.log', excludes)).toBe(true);
    expect(isPathExcluded('nested/deep/debug.txt', excludes)).toBe(false);
  });

  it('returns false for an empty exclude list', () => {
    expect(isPathExcluded('anything', [])).toBe(false);
  });

  it('matches an exact file path', () => {
    const excludes = normalizeExcludes(['src/generated.ts']);
    expect(isPathExcluded('src/generated.ts', excludes)).toBe(true);
    expect(isPathExcluded('src/generated2.ts', excludes)).toBe(false);
  });

  it('escapes ? so it matches only a literal question mark, not "any one character"', () => {
    const excludes = normalizeExcludes(['weird?file.txt']);
    expect(isPathExcluded('weird?file.txt', excludes)).toBe(true);
    expect(isPathExcluded('weirdXfile.txt', excludes)).toBe(false);
  });
});

describe('excludePathspecs', () => {
  it('produces a literal pathspec for each wildcard-free pattern', () => {
    expect(excludePathspecs(['.vouch', '.lavish'])).toEqual([
      ':(exclude,literal).vouch',
      ':(exclude,literal).lavish',
    ]);
  });

  it('omits patterns containing * so git never re-interprets the wildcard itself', () => {
    expect(excludePathspecs(['*.log', '**/*.log', '.vouch'])).toEqual([':(exclude,literal).vouch']);
  });

  it('returns an empty array for no excludes', () => {
    expect(excludePathspecs([])).toEqual([]);
  });
});
