import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { TextDecoder } from 'node:util';
import { parseUnifiedDiff } from './diff.js';
import { hashText } from './hash.js';
import { excludePathspecs, isPathExcluded, normalizeExcludesOrUndefined } from './path-excludes.js';
import type { ReviewSource, SourceFile } from './types.js';

export interface CommandResult {
  exitCode: number;
  stdout: string | Buffer;
  stderr: string;
}

export interface CommandRunner {
  run(command: string, args: readonly string[], options: { cwd: string }): CommandResult;
}

export interface CaptureFileOptions {
  root: string;
  runner?: CommandRunner;
  readFile?: (path: string) => string;
  /** Repository-relative path patterns to keep out of the capture entirely. */
  excludes?: string[];
}

export interface CapturePrOptions extends CaptureFileOptions {
  selector: string;
}

export interface CaptureScopeOptions extends CaptureFileOptions {
  patterns: string[];
}

export type ReviewCaptureSourceRequest =
  | { kind: 'pr'; selector: string; excludes?: string[] }
  | { kind: 'staged'; excludes?: string[] }
  | { kind: 'unstaged'; excludes?: string[] }
  | { kind: 'scope'; patterns: string[]; excludes?: string[] };

export interface CaptureReviewSourceRequest extends CaptureFileOptions {
  source: ReviewCaptureSourceRequest;
}

export interface CapturedReviewSource {
  source: ReviewSource;
  fingerprint: string;
  eligiblePaths: string[];
  patch?: string;
  files?: SourceFile[];
  title?: string;
  fingerprintContent?: string;
}

export interface ReviewSourceFreshness {
  sourceChanged: boolean;
  captureFailed: boolean;
}

interface PullRequestView {
  number: number;
  title: string;
  url: string;
  baseRefOid: string;
  headRefOid: string;
}

interface ExecError extends Error {
  status?: number;
  stdout?: string | Buffer;
  stderr?: string | Buffer;
  code?: string;
}

function stringifyOutput(value: string | Buffer | undefined): string {
  if (typeof value === 'string') return value;
  return value?.toString('utf8') ?? '';
}

export const systemCommandRunner: CommandRunner = {
  run(command, args, options): CommandResult {
    try {
      return {
        exitCode: 0,
        stdout: execFileSync(command, args, { cwd: options.cwd }),
        stderr: '',
      };
    } catch (error) {
      const commandError = error as ExecError;
      return {
        exitCode: commandError.status ?? 1,
        stdout: stringifyOutput(commandError.stdout),
        stderr:
          commandError.code === 'ENOENT' ? commandError.code : stringifyOutput(commandError.stderr),
      };
    }
  },
};

function assertSafeRepositoryPath(path: string): void {
  if (
    path.length === 0 ||
    path.includes('\0') ||
    path.startsWith('/') ||
    path.startsWith('\\') ||
    path.split(/[\\/]/u).some((segment) => segment === '.' || segment === '..')
  ) {
    throw new Error(`invalid repository-relative path: ${path}`);
  }
}

function parseNulPaths(value: Buffer): string[] {
  const paths: string[] = [];
  let start = 0;
  for (let end = value.indexOf(0, start); end !== -1; end = value.indexOf(0, start)) {
    if (end > start) {
      const bytes = value.subarray(start, end);
      const path = decodeUtf8(bytes);
      if (path === undefined) {
        throw new Error(
          'Git returned a non-UTF-8 repository path; rename it before review capture.',
        );
      }
      paths.push(path);
    }
    start = end + 1;
  }
  if (start < value.length) {
    const path = decodeUtf8(value.subarray(start));
    if (path === undefined) {
      throw new Error('Git returned a non-UTF-8 repository path; rename it before review capture.');
    }
    paths.push(path);
  }
  for (const path of paths) assertSafeRepositoryPath(path);
  return [...new Set(paths)].sort();
}

interface RepositoryEntry {
  bytes: Buffer;
  mode: number;
}

const PREVIEW_RUNTIME_PATHS = new Set<string>([
  '.synergy/preview.runtime.json',
  '.synergy/preview.runtime.json.mutation.lock',
  '.synergy/preview.start.lock',
  '.synergy/preview.pid',
  '.synergy/preview.log',
]);

function isPreviewRuntimePath(path: string): boolean {
  return (
    PREVIEW_RUNTIME_PATHS.has(path) ||
    path.startsWith('.synergy/preview.runtime.json.quarantine.') ||
    (path.startsWith('.synergy/.preview.runtime.json.') && path.endsWith('.tmp')) ||
    path.startsWith('.synergy/preview.start.lock.quarantine.') ||
    path.startsWith('.synergy/preview.start.lock.owner.tmp.')
  );
}

interface FilteredPatch {
  patch: string;
  /** True when at least one chunk was dropped because it matched a user exclude pattern. */
  excludedAny: boolean;
}

/**
 * Drops whole-file patch chunks for Synergy's own runtime files and, when `excludes` is
 * non-empty, for any user-excluded path - in one pass so each chunk is parsed once. This is
 * the only enforcement mechanism available for PR capture, because `gh pr diff` accepts no
 * pathspec; other capture paths also pass `excludes` as git pathspecs (see `excludePathspecs`)
 * so excluded files are never read off disk in the first place, with this filter remaining the
 * correctness backstop.
 */
function filterPatch(patch: string, excludes: readonly string[]): FilteredPatch {
  let excludedAny = false;
  const filtered = patch
    .split(/(?=^diff --git )/mu)
    .filter((chunk) => {
      const files = parseUnifiedDiff(chunk);
      if (files.length === 0) return true;
      const isRuntimeMatch = (file: (typeof files)[number]) =>
        isPreviewRuntimePath(file.path) ||
        (file.previousPath !== undefined && isPreviewRuntimePath(file.previousPath));
      const isUserExcludeMatch = (file: (typeof files)[number]) =>
        isPathExcluded(file.path, excludes) ||
        (file.previousPath !== undefined && isPathExcluded(file.previousPath, excludes));
      if (files.some(isRuntimeMatch)) return false;
      if (files.some(isUserExcludeMatch)) {
        excludedAny = true;
        return false;
      }
      return true;
    })
    .join('');
  return { patch: filtered, excludedAny };
}

const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

function decodeUtf8(bytes: Buffer): string | undefined {
  try {
    return UTF8_DECODER.decode(bytes);
  } catch {
    return undefined;
  }
}

function readRepositoryEntry(
  root: string,
  path: string,
  readFile?: (path: string) => string,
): RepositoryEntry {
  assertSafeRepositoryPath(path);
  try {
    const lexicalRoot = resolve(root);
    const lexicalPath = resolve(lexicalRoot, path);
    if (relative(lexicalRoot, lexicalPath).startsWith('..')) {
      throw new Error(`repository path escapes root: ${path}`);
    }
    if (readFile) return { bytes: Buffer.from(readFile(lexicalPath), 'utf8'), mode: 0o100644 };
    const canonicalRoot = realpathSync(root);
    const absolutePath = resolve(canonicalRoot, path);
    let currentPath = canonicalRoot;
    for (const segment of path.split('/')) {
      currentPath = join(currentPath, segment);
      if (lstatSync(currentPath).isSymbolicLink()) {
        throw new Error(`eligible path contains a symbolic link: ${path}`);
      }
    }
    // Node does not expose openat(2) with O_NOFOLLOW for each component. The component
    // walk plus this final realpath check detects symlink escapes before the read, but a
    // hostile concurrent filesystem mutation can still race between verification and read.
    const resolvedPath = realpathSync(absolutePath);
    if (relative(canonicalRoot, resolvedPath).startsWith('..')) {
      throw new Error(`repository path escapes root: ${path}`);
    }
    const metadata = lstatSync(resolvedPath);
    if (metadata.isSymbolicLink()) {
      throw new Error(`eligible path is a symbolic link: ${path}`);
    }
    if (!metadata.isFile()) throw new Error(`eligible path is not a regular file: ${path}`);
    return { bytes: readFileSync(resolvedPath), mode: metadata.mode };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (/symbolic link/u.test(detail)) throw error;
    throw new Error(`unable to read eligible file ${path}: ${detail}`);
  }
}

function quoteGitPath(path: string): string {
  return `"${path
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\t/g, '\\t')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')}"`;
}

function gitFileMode(mode: number): string {
  return mode & 0o111 ? '100755' : '100644';
}

function syntheticAddedFilePatch(path: string, entry: RepositoryEntry): string {
  const oldPath = quoteGitPath(`a/${path}`);
  const newPath = quoteGitPath(`b/${path}`);
  const content = decodeUtf8(entry.bytes);
  if (entry.bytes.includes(0) || content === undefined) {
    return [
      `diff --git ${oldPath} ${newPath}`,
      `new file mode ${gitFileMode(entry.mode)}`,
      `Binary files /dev/null and ${newPath} differ`,
      `# synergy-binary-sha256 ${hashText(entry.bytes.toString('base64'))}`,
    ].join('\n');
  }
  const hasFinalNewline = content.endsWith('\n');
  const lines = content.length === 0 ? [] : content.split('\n');
  if (hasFinalNewline) lines.pop();
  const additions = lines.map((line) => `+${line}`);
  const hunk = lines.length === 0 ? [] : [`@@ -0,0 +1,${lines.length} @@`, ...additions];
  if (!hasFinalNewline && lines.length > 0) hunk.push('\\ No newline at end of file');
  return [
    `diff --git ${oldPath} ${newPath}`,
    `new file mode ${gitFileMode(entry.mode)}`,
    '--- /dev/null',
    `+++ ${newPath}`,
    ...hunk,
  ].join('\n');
}

function commandFailure(command: string, result: CommandResult): Error {
  const detail = `${result.stderr}\n${result.stdout}`.trim();
  const lower = detail.toLowerCase();
  if (result.stderr === 'ENOENT') {
    return new Error(
      command === 'gh'
        ? 'GitHub CLI (gh) is required for PR reviews. Install it, then run gh auth login.'
        : 'Git is required for review capture. Install Git and run this command inside a repository.',
    );
  }
  if (command === 'gh' && /auth|login|not logged/i.test(lower)) {
    return new Error('GitHub PR access is unavailable. Run gh auth login, then retry the review.');
  }
  if (command === 'git' && /not a git repository/i.test(lower)) {
    return new Error(
      'Review capture requires a Git repository. Run this command from a repository root.',
    );
  }
  return new Error(
    `${command === 'gh' ? 'GitHub PR capture' : 'Git capture'} failed${detail ? `: ${detail}` : ''}`,
  );
}

function runChecked(runner: CommandRunner, root: string, command: string, args: string[]): string {
  const result = runner.run(command, args, { cwd: root });
  if (result.exitCode !== 0) throw commandFailure(command, result);
  return stringifyOutput(result.stdout);
}

function runCheckedBuffer(
  runner: CommandRunner,
  root: string,
  command: string,
  args: string[],
): Buffer {
  const result = runner.run(command, args, { cwd: root });
  if (result.exitCode !== 0) throw commandFailure(command, result);
  return typeof result.stdout === 'string' ? Buffer.from(result.stdout, 'utf8') : result.stdout;
}

function assertCapturedPatch(patch: string, source: string, excludedEverything = false): string[] {
  const files = parseUnifiedDiff(patch);
  if (files.length === 0) {
    if (excludedEverything) {
      throw new Error(
        `Exclude patterns removed every ${source} change; no review was created. Adjust --exclude and try again.`,
      );
    }
    throw new Error(`No ${source} changes were found; no review was created.`);
  }
  return files.map((file) => file.path).sort();
}

function sourceFingerprint(source: ReviewSource, content: string): string {
  return hashText(`${JSON.stringify(source)}\n${content}`);
}

function readTextSourceFiles(
  root: string,
  paths: string[],
  readFile?: (path: string) => string,
): { files: SourceFile[]; fingerprintContent: string } {
  const files: SourceFile[] = [];
  const content: string[] = [];
  for (const path of paths) {
    const entry = readRepositoryEntry(root, path, readFile);
    const text = decodeUtf8(entry.bytes);
    content.push(
      `${path}\0${gitFileMode(entry.mode)}\0${hashText(entry.bytes.toString('base64'))}`,
    );
    if (entry.bytes.includes(0) || text === undefined) {
      files.push({ path, lines: [], binary: true });
      continue;
    }
    files.push({
      path,
      binary: false,
      lines: text.split(/\r?\n/u).map((line, index) => ({ number: index + 1, text: line })),
    });
  }
  return { files, fingerprintContent: content.join('\n') };
}

function parsePullRequestView(value: string): PullRequestView {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(
      'GitHub PR capture returned invalid metadata. Retry after checking gh authentication.',
    );
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('number' in parsed) ||
    !('title' in parsed) ||
    !('url' in parsed) ||
    !('baseRefOid' in parsed) ||
    !('headRefOid' in parsed) ||
    typeof parsed.number !== 'number' ||
    typeof parsed.title !== 'string' ||
    typeof parsed.url !== 'string' ||
    typeof parsed.baseRefOid !== 'string' ||
    typeof parsed.headRefOid !== 'string'
  ) {
    throw new Error(
      'GitHub PR capture returned incomplete metadata. Retry with a valid PR number or URL.',
    );
  }
  return {
    number: parsed.number,
    title: parsed.title,
    url: parsed.url,
    baseRefOid: parsed.baseRefOid,
    headRefOid: parsed.headRefOid,
  };
}

export function capturePr(options: CapturePrOptions): CapturedReviewSource {
  const runner = options.runner ?? systemCommandRunner;
  const excludes = normalizeExcludesOrUndefined(options.excludes) ?? [];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const before = parsePullRequestView(
      runChecked(runner, options.root, 'gh', [
        'pr',
        'view',
        options.selector,
        '--json',
        'number,title,url,baseRefOid,headRefOid',
      ]),
    );
    const rawDiff = runChecked(runner, options.root, 'gh', ['pr', 'diff', before.url]);
    const { patch, excludedAny } = filterPatch(rawDiff, excludes);
    const after = parsePullRequestView(
      runChecked(runner, options.root, 'gh', [
        'pr',
        'view',
        before.url,
        '--json',
        'number,title,url,baseRefOid,headRefOid',
      ]),
    );
    if (before.baseRefOid !== after.baseRefOid || before.headRefOid !== after.headRefOid) continue;
    const source: ReviewSource = {
      kind: 'pr',
      number: after.number,
      url: after.url,
      baseSha: after.baseRefOid,
      headSha: after.headRefOid,
      ...(excludes.length > 0 ? { excludes } : {}),
    };
    const excludedEverything = excludedAny && parseUnifiedDiff(patch).length === 0;
    const eligiblePaths = assertCapturedPatch(patch, 'PR', excludedEverything);
    return {
      source,
      title: after.title,
      patch,
      eligiblePaths,
      fingerprint: sourceFingerprint(source, patch),
    };
  }
  throw new Error(
    'The PR changed while its diff was captured. Retry after the PR head stabilizes.',
  );
}

export function captureStaged(options: CaptureFileOptions): CapturedReviewSource {
  const runner = options.runner ?? systemCommandRunner;
  const excludes = normalizeExcludesOrUndefined(options.excludes) ?? [];
  const rawDiff = runChecked(runner, options.root, 'git', [
    'diff',
    '--cached',
    '--no-ext-diff',
    '--binary',
  ]);
  const { patch, excludedAny } = filterPatch(rawDiff, excludes);
  const source: ReviewSource = {
    kind: 'staged',
    headSha: '',
    ...(excludes.length > 0 ? { excludes } : {}),
  };
  const excludedEverything = excludedAny && parseUnifiedDiff(patch).length === 0;
  const eligiblePaths = assertCapturedPatch(patch, 'staged', excludedEverything);
  return { source, patch, eligiblePaths, fingerprint: sourceFingerprint(source, patch) };
}

export function captureUnstaged(options: CaptureFileOptions): CapturedReviewSource {
  const runner = options.runner ?? systemCommandRunner;
  const excludes = normalizeExcludesOrUndefined(options.excludes) ?? [];
  const trackedRaw = runChecked(runner, options.root, 'git', [
    'diff',
    '--no-ext-diff',
    '--binary',
    '--',
    ':(exclude).synergy/preview.runtime.json',
    ':(exclude).synergy/preview.runtime.json.*',
    ':(exclude).synergy/.preview.runtime.json.*.tmp',
    ':(exclude).synergy/preview.start.lock',
    ':(exclude).synergy/preview.start.lock.*',
    ':(exclude).synergy/preview.pid',
    ':(exclude).synergy/preview.log',
    ...excludePathspecs(excludes),
  ]);
  const { patch: trackedPatch, excludedAny: trackedExcludedAny } = filterPatch(
    trackedRaw,
    excludes,
  );
  const allUntrackedPaths = parseNulPaths(
    runCheckedBuffer(runner, options.root, 'git', [
      'ls-files',
      '--others',
      '--exclude-standard',
      '-z',
    ]),
  ).filter((path) => !isPreviewRuntimePath(path));
  const untrackedPaths = allUntrackedPaths.filter((path) => !isPathExcluded(path, excludes));
  const untrackedExcludedAny = untrackedPaths.length < allUntrackedPaths.length;
  const untrackedEntries = untrackedPaths.map((path) => ({
    path,
    entry: readRepositoryEntry(options.root, path, options.readFile),
  }));
  const untrackedPatches = untrackedEntries.map(({ path, entry }) =>
    syntheticAddedFilePatch(path, entry),
  );
  const patch = [trackedPatch.trimEnd(), ...untrackedPatches].filter(Boolean).join('\n');
  const source: ReviewSource = {
    kind: 'unstaged',
    headSha: '',
    ...(excludes.length > 0 ? { excludes } : {}),
  };
  const excludedEverything =
    (trackedExcludedAny || untrackedExcludedAny) && parseUnifiedDiff(patch).length === 0;
  const eligiblePaths = assertCapturedPatch(patch, 'unstaged', excludedEverything);
  const fingerprintContent = [
    patch,
    ...untrackedEntries.map(
      ({ path, entry }) =>
        `${path}\0${gitFileMode(entry.mode)}\0${hashText(entry.bytes.toString('base64'))}`,
    ),
  ].join('\n');
  return {
    source,
    patch,
    eligiblePaths,
    fingerprintContent,
    fingerprint: sourceFingerprint(source, fingerprintContent),
  };
}

export function captureScope(options: CaptureScopeOptions): CapturedReviewSource {
  if (options.patterns.length === 0)
    throw new Error('Scope review requires at least one repository-relative path.');
  const patterns = [...new Set(options.patterns.map(normalizeScopePattern))].sort();
  for (const pattern of patterns) assertSafeRepositoryPath(pattern);
  const excludes = normalizeExcludesOrUndefined(options.excludes) ?? [];
  const runner = options.runner ?? systemCommandRunner;
  const rawPaths = parseNulPaths(
    runCheckedBuffer(runner, options.root, 'git', [
      'ls-files',
      '--cached',
      '--others',
      '--exclude-standard',
      '-z',
      '--',
      ...patterns,
      ...excludePathspecs(excludes),
    ]),
  ).filter((path) => !isPreviewRuntimePath(path));
  const paths = rawPaths.filter((path) => !isPathExcluded(path, excludes));
  if (paths.length === 0) {
    const excludedEverything = excludes.length > 0 && rawPaths.length > paths.length;
    throw new Error(
      excludedEverything
        ? 'Exclude patterns removed every scoped file; no review was created. Adjust --exclude and try again.'
        : 'Scope resolved to no eligible files. Choose a different path.',
    );
  }
  const source: ReviewSource = {
    kind: 'scope',
    patterns,
    headSha: '',
    ...(excludes.length > 0 ? { excludes } : {}),
  };
  const captured = readTextSourceFiles(options.root, paths, options.readFile);
  if (captured.files.every((file) => file.binary)) {
    throw new Error('Scope contains only binary files; choose text files to review.');
  }
  return {
    source,
    files: captured.files,
    eligiblePaths: paths,
    fingerprintContent: captured.fingerprintContent,
    fingerprint: sourceFingerprint(source, captured.fingerprintContent),
  };
}

export function captureReviewSource(request: CaptureReviewSourceRequest): CapturedReviewSource {
  if (request.source.kind === 'pr') {
    return capturePr({
      ...request,
      selector: request.source.selector,
      excludes: request.source.excludes,
    });
  }
  const runner = request.runner ?? systemCommandRunner;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const before = runChecked(runner, request.root, 'git', ['rev-parse', 'HEAD']).trim();
    const captured =
      request.source.kind === 'staged'
        ? captureStaged({ ...request, excludes: request.source.excludes })
        : request.source.kind === 'unstaged'
          ? captureUnstaged({ ...request, excludes: request.source.excludes })
          : captureScope({
              ...request,
              patterns: request.source.patterns,
              excludes: request.source.excludes,
            });
    const after = runChecked(runner, request.root, 'git', ['rev-parse', 'HEAD']).trim();
    if (before !== after) continue;
    const source = { ...captured.source, headSha: after };
    const fingerprintContent = captured.fingerprintContent ?? captured.patch ?? '';
    return { ...captured, source, fingerprint: sourceFingerprint(source, fingerprintContent) };
  }
  throw new Error(
    'Local Git HEAD changed while the review source was captured. Retry after it stabilizes.',
  );
}

/** Re-captures the exact source selector stored in an immutable snapshot. */
export function recaptureReviewSource(
  source: ReviewSource,
  root: string,
  dependencies: Omit<CaptureFileOptions, 'root'> = {},
): CapturedReviewSource {
  const requestSource: ReviewCaptureSourceRequest =
    source.kind === 'pr'
      ? { kind: 'pr', selector: source.url, excludes: source.excludes }
      : source.kind === 'scope'
        ? { kind: 'scope', patterns: source.patterns, excludes: source.excludes }
        : { kind: source.kind, excludes: source.excludes };
  return captureReviewSource({ root, ...dependencies, source: requestSource });
}

/**
 * Compares a current capture to an immutable source fingerprint. Capture failures fail closed:
 * callers must not report review readiness when current source cannot be proven unchanged.
 */
export function compareReviewSourceFreshness(
  snapshot: Pick<CapturedReviewSource, 'source' | 'fingerprint'>,
  root: string,
  dependencies: Omit<CaptureFileOptions, 'root'> = {},
): ReviewSourceFreshness {
  try {
    const captured = recaptureReviewSource(snapshot.source, root, dependencies);
    return { sourceChanged: captured.fingerprint !== snapshot.fingerprint, captureFailed: false };
  } catch {
    return { sourceChanged: true, captureFailed: true };
  }
}

function normalizeScopePattern(pattern: string): string {
  let normalized = pattern;
  while (normalized.startsWith('./')) normalized = normalized.slice(2);
  while (normalized.endsWith('/')) normalized = normalized.slice(0, -1);
  return normalized;
}

export function resolveRepositoryRoot(
  root: string,
  runner: CommandRunner = systemCommandRunner,
): string {
  const gitRoot = runChecked(runner, root, 'git', ['rev-parse', '--show-toplevel']).trim();
  if (!gitRoot) throw new Error('Git did not return a repository root for review capture.');
  return existsSync(gitRoot) ? realpathSync(gitRoot) : resolve(gitRoot);
}

export function repositoryName(root: string): string {
  return (
    basename(resolve(root))
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'repository'
  );
}
