/**
 * Repository-relative path exclusion matching shared by every review capture path.
 *
 * Matching semantics:
 * - Patterns are repository-relative (never absolute, never containing `..` segments).
 * - A pattern naming a directory (`.vouch` or `.vouch/`) excludes that path AND everything
 *   beneath it. A sibling that merely shares a text prefix (`.vouchx/file.ts`) is NOT excluded
 *   by a `.vouch` pattern - matching is always on full path segments.
 * - `*` matches any run of characters within a single path segment (never crosses `/`).
 * - `**` matches any run of characters, including `/` - it crosses directory boundaries.
 * - Callers never supply git pathspec magic (a leading `:`) - pathspecs are constructed
 *   internally via `excludePathspecs`.
 *
 * This module is the ONLY authority on glob semantics. `excludePathspecs` never emits a git
 * pathspec that could exclude more than this matcher would - git's own wildcard fallback
 * (`fnmatch(3)` without `FNM_PATHNAME`, which lets a bare `*` cross `/`) does not agree with the
 * single-segment `*` semantics documented above, so any pattern containing `*` is left for this
 * module to filter in JS; only wildcard-free patterns get a (literal, therefore safe) pathspec.
 */

const EXCLUDE_REGEX_CACHE = new Map<string, RegExp>();
const WINDOWS_DRIVE_ABSOLUTE = /^[A-Za-z]:[\\/]/u;

function assertSafeExcludePattern(pattern: string): void {
  if (
    pattern.length === 0 ||
    pattern.trim().length === 0 ||
    pattern.includes('\0') ||
    pattern.startsWith('/') ||
    pattern.startsWith('\\') ||
    pattern.startsWith(':') ||
    WINDOWS_DRIVE_ABSOLUTE.test(pattern) ||
    pattern.split(/[\\/]/u).some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new Error(`invalid exclude pattern: ${pattern}`);
  }
}

/** Trims, strips a leading `./`, and collapses trailing slashes so directory forms collapse. */
export function normalizeExcludePattern(raw: string): string {
  let normalized = raw.trim();
  while (normalized.startsWith('./')) normalized = normalized.slice(2);
  while (normalized.length > 1 && normalized.endsWith('/')) normalized = normalized.slice(0, -1);
  assertSafeExcludePattern(normalized);
  return normalized;
}

/** Normalizes, dedupes, and sorts a set of exclude patterns so equivalent input is identical. */
export function normalizeExcludes(patterns: readonly string[]): string[] {
  return [...new Set(patterns.map(normalizeExcludePattern))].sort();
}

/** Normalizes excludes, returning `undefined` for an empty/absent set (preserves optionality). */
export function normalizeExcludesOrUndefined(
  patterns: readonly string[] | undefined,
): string[] | undefined {
  if (patterns === undefined) return undefined;
  const normalized = normalizeExcludes(patterns);
  return normalized.length === 0 ? undefined : normalized;
}

function escapeRegExpChar(char: string): string {
  return /[.+^${}()|[\]\\?]/u.test(char) ? `\\${char}` : char;
}

function globToRegexSource(pattern: string): string {
  let out = '';
  let index = 0;
  while (index < pattern.length) {
    if (pattern.startsWith('**/', index)) {
      // `**/` matches zero or more whole path segments, including none.
      out += '(?:.*/)?';
      index += 3;
      continue;
    }
    if (pattern.startsWith('/**', index)) {
      // `/**` matches the rest of the path under this directory, including nothing further.
      out += '(?:/.*)?';
      index += 3;
      continue;
    }
    if (pattern.startsWith('**', index)) {
      out += '.*';
      index += 2;
      continue;
    }
    const char = pattern[index] as string;
    out += char === '*' ? '[^/]*' : escapeRegExpChar(char);
    index += 1;
  }
  return out;
}

function compileExcludePattern(pattern: string): RegExp {
  const cached = EXCLUDE_REGEX_CACHE.get(pattern);
  if (cached) return cached;
  const regex = new RegExp(`^${globToRegexSource(pattern)}(?:/.*)?$`);
  EXCLUDE_REGEX_CACHE.set(pattern, regex);
  return regex;
}

/** True when `path` (repository-relative) matches any normalized exclude pattern. */
export function isPathExcluded(path: string, excludes: readonly string[]): boolean {
  if (excludes.length === 0) return false;
  return excludes.some((pattern) => compileExcludePattern(pattern).test(path));
}

/**
 * Builds git pathspec arguments that pre-filter excluded files at the git level, as a
 * performance optimization so excluded files are never read off disk. Only wildcard-free
 * patterns are emitted, using `:(literal)` magic so git never re-interprets `*`/`?`/`[]` with
 * its own (`*` crosses `/`) wildcard semantics - git's plain literal pathspec matching already
 * matches a path exactly or as a leading directory component, which agrees with this module's
 * directory-prefix rule. A pattern containing `*` is omitted here entirely and left for
 * `isPathExcluded`/patch filtering to enforce, so this function never excludes more than the JS
 * matcher would; that is always the correctness backstop.
 */
export function excludePathspecs(excludes: readonly string[]): string[] {
  return excludes
    .filter((pattern) => !pattern.includes('*'))
    .map((pattern) => `:(exclude,literal)${pattern}`);
}
