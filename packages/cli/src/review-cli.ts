import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import {
  assertSafeReviewSegment,
  claimQuestion,
  failQuestion,
  normalizeExcludes,
  parseReviewRef,
  writeAnswer,
} from '@synergy/review-core';
import type { CAC } from 'cac';
import { bold, dim, green, red, yellow } from 'kleur/colors';
import { parseDuration } from './feedback-wait.js';
import {
  PreviewNotReadyError,
  applyReviewAnalysis,
  createOrResumeReview,
  formatReviewStatusJson,
  listReviews,
  openReview,
  printReviewStatus,
  refreshReview,
} from './review-actions.js';
import { type ReviewAnalysisInput, parseReviewAnalysisInput } from './review-analysis.js';
import { type ReviewCaptureSourceRequest, resolveRepositoryRoot } from './review-capture.js';
import { type ReviewWaitResult, waitForReviewQuestions } from './review-wait.js';

interface ReviewCreateFlags {
  root?: string;
  pr?: string;
  staged?: boolean;
  unstaged?: boolean;
  scope?: string;
  json?: boolean;
  /** Repository-relative path pattern(s) to exclude from the review. CAC yields a bare string
   * for one `--exclude` occurrence and an array for several. */
  exclude?: string | string[];
  /** Require every derived removal run to carry a rationale before analysis can finalize.
   * `true` when `--explain-removals` is given, `false` when `--no-explain-removals` is given
   * (CAC parses the `no-` prefix into a boolean without the flag needing separate declaration),
   * `undefined` when neither is given - "no opinion", not "off". Create only. See
   * `ValidatedReviewCommand.explainRemovals` and `CreateReviewRequest.explainRemovals` for how
   * that tri-state is threaded through and honored. */
  explainRemovals?: boolean;
}

interface ReviewCommandFlags extends ReviewCreateFlags {
  bodyFile?: string;
  for?: string;
  review?: string;
  '--'?: string[];
  [key: string]: unknown;
}

export class ReviewUsageError extends Error {}

export interface ReviewCliDependencies {
  openReview?: typeof openReview;
  applyReviewAnalysis?: typeof applyReviewAnalysis;
  monotonicNow?: () => number;
}

/** Normalizes the `--exclude` flag's CAC shape (undefined, a bare string for one occurrence, or
 * an array for several) into a sorted, deduped pattern list, or `undefined` when the flag was
 * not given. Surfaces `normalizeExcludes`'s validation errors (unsafe patterns) as a usage error
 * naming the offending pattern rather than a raw stack trace.
 *
 * The parameter type says `string | string[] | undefined`, but CAC does not actually enforce
 * that at runtime: a valueless occurrence (`--exclude` with nothing after it, or followed
 * immediately by another flag) yields the boolean `true` instead. Passing that straight to
 * `normalizeExcludes` reaches `raw.trim()` on a boolean and throws `raw.trim is not a function`,
 * which surfaces to the user as a raw stack trace instead of a usage error - so this validates
 * every entry is actually a string before normalizing. */
function excludesFromFlag(value: string | string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const raw = Array.isArray(value) ? value : [value];
  if (raw.some((entry) => typeof entry !== 'string')) {
    throw new ReviewUsageError('--exclude requires a pattern value, e.g. --exclude .vouch');
  }
  try {
    const normalized = normalizeExcludes(raw);
    return normalized.length > 0 ? normalized : undefined;
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'invalid exclude pattern';
    throw new ReviewUsageError(detail);
  }
}

export function createReviewSourceFromFlags(flags: ReviewCreateFlags): ReviewCaptureSourceRequest {
  const selected = [
    flags.pr !== undefined,
    flags.staged === true,
    flags.unstaged === true,
    flags.scope !== undefined,
  ].filter(Boolean).length;
  if (selected !== 1) {
    throw new ReviewUsageError(
      'review create requires exactly one of --pr, --staged, --unstaged, or --scope',
    );
  }
  const excludes = excludesFromFlag(flags.exclude);
  if (flags.pr !== undefined) {
    return { kind: 'pr', selector: flags.pr, ...(excludes ? { excludes } : {}) };
  }
  if (flags.staged) return { kind: 'staged', ...(excludes ? { excludes } : {}) };
  if (flags.unstaged) return { kind: 'unstaged', ...(excludes ? { excludes } : {}) };
  if (!flags.scope || flags.scope.trim().length === 0) {
    throw new ReviewUsageError('--scope cannot be empty');
  }
  return { kind: 'scope', patterns: [flags.scope], ...(excludes ? { excludes } : {}) };
}

function printCreateResult(
  result: ReturnType<typeof createOrResumeReview>,
  json: boolean | undefined,
): void {
  const reference = `${result.reference.workspaceId}@${result.reference.revisionId}`;
  if (json) {
    process.stdout.write(`${JSON.stringify({ ...result, reference }, null, 2)}\n`);
    return;
  }
  const preparation = result.analysisRequired ? 'analysis required' : 'ready for review';
  const excludedLine =
    result.excludedFileCount && result.excludedFileCount > 0
      ? `${dim('Excluded:')} ${result.excludedFileCount} file${result.excludedFileCount === 1 ? '' : 's'} via ${result.excludes?.length ?? 0} pattern${result.excludes?.length === 1 ? '' : 's'}\n`
      : '';
  // Always printed, never conditional on a flag having been passed this call: a silently
  // unchanged policy looks identical to one that was just turned off unless the effective state
  // is reported every time. `previousAnalysisPolicy` (set only when this call actually flipped
  // the stored value) upgrades that into an explicit before/after when it applies.
  const removalsState = result.analysisPolicy.explainRemovals ? 'on' : 'off';
  const removalsChangeNote = result.previousAnalysisPolicy
    ? ` (was ${result.previousAnalysisPolicy.explainRemovals ? 'on' : 'off'})`
    : '';
  const removalsLine = `${dim('Removals:')} explanations ${removalsState}${removalsChangeNote}\n`;
  const lockedLine = result.analysisPolicyLocked
    ? `${yellow('Note:')} --explain-removals was requested but the current revision's analysis is already finalized and immutable; the stored policy was left unchanged (${result.analysisPolicy.explainRemovals ? 'on' : 'off'}).\n`
    : '';
  process.stdout.write(
    `${green('✓')} ${bold(reference)} ${dim(result.resumed ? 'resumed' : 'created')}\n${dim('Preparation:')} ${preparation}\n${excludedLine}${removalsLine}${lockedLine}${dim('Open:')} ${result.url}\n`,
  );
}

function printError(error: unknown, exitCode: number, json: boolean | undefined): void {
  if (json && error instanceof PreviewNotReadyError) {
    process.stdout.write(
      `${JSON.stringify({ error: error.code, message: error.message, root: error.root, suggestedCommand: error.suggestedCommand })}\n`,
    );
    process.exitCode = exitCode;
    return;
  }
  const message = error instanceof Error ? error.message : 'unexpected review command failure';
  process.stderr.write(`${red('Error:')} ${message}\n`);
  process.exitCode = exitCode;
}

function parseUsageReviewRef(value: string) {
  try {
    return parseReviewRef(value);
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'invalid review reference';
    throw new ReviewUsageError(detail);
  }
}

function readUsageAnalysis(path: string): ReviewAnalysisInput {
  try {
    const body = readFileSync(path, 'utf8');
    let value: unknown;
    try {
      value = JSON.parse(body);
    } catch {
      throw new ReviewUsageError('$ must contain valid JSON');
    }
    return parseReviewAnalysisInput(value);
  } catch (error) {
    if (error instanceof ReviewUsageError) throw error;
    const detail = error instanceof Error ? error.message : 'invalid analysis body';
    throw new ReviewUsageError(detail);
  }
}

function readUsageAnswer(path: string): string {
  try {
    const body = readFileSync(path, 'utf8');
    if (body.trim().length === 0) throw new Error('answer body must not be empty');
    return body;
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'invalid answer body';
    throw new ReviewUsageError(`invalid answer body: ${detail}`);
  }
}

const REVIEW_ACTIONS = [
  'create',
  'refresh',
  'analysis-set',
  'list',
  'open',
  'status',
  'wait',
  'answer',
] as const;
type ReviewAction = (typeof REVIEW_ACTIONS)[number];

interface ValidatedReviewCommand {
  action: ReviewAction;
  source?: ReviewCaptureSourceRequest;
  /** Tri-state, mirroring `CreateReviewRequest.explainRemovals`: `true` for `--explain-removals`,
   * `false` for `--no-explain-removals`, `undefined` when neither flag was given - "no opinion",
   * which `createOrResumeReview` reads as "leave the workspace's stored policy untouched" on a
   * resume, or "off" on a brand-new workspace's first capture. This is NOT coerced to a boolean
   * here; doing so at this layer previously collapsed "no opinion" into "off" and silently
   * disabled the gate on every re-run of `create` that omitted the flag - see the `create` case
   * below and `assertNoConflictingExplainRemovalsFlags`. */
  explainRemovals?: boolean;
  workspaceId?: string;
  reference?: ReturnType<typeof parseReviewRef>;
  analysis?: ReviewAnalysisInput;
  analysisParsingMs?: number;
  questionId?: string;
  answerBody?: string;
  timeoutMs?: number;
}

function assertKnownAction(action: string): asserts action is ReviewAction {
  if (!REVIEW_ACTIONS.some((knownAction) => knownAction === action)) {
    throw new ReviewUsageError(
      'unknown review action — use create, refresh, analysis-set, list, open, status, wait, or answer',
    );
  }
}

function requireValidatedValue<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('validated review command is missing required data');
  return value;
}

function assertKnownOptions(flags: ReviewCommandFlags): void {
  const known = new Set([
    'root',
    'pr',
    'staged',
    'unstaged',
    'scope',
    'json',
    'bodyFile',
    'for',
    'review',
    'exclude',
    'explainRemovals',
    '--',
  ]);
  const unknown = Object.keys(flags).find((flag) => !known.has(flag));
  if (unknown) throw new ReviewUsageError(`unknown review option --${unknown}`);
  if (flags['--'] && flags['--'].length > 0) {
    throw new ReviewUsageError('review does not accept arguments after --');
  }
}

function assertReferenceCount(action: ReviewAction, references: string[], expected: 0 | 1): void {
  if (references.length === expected) return;
  if (expected === 0) throw new ReviewUsageError(`review ${action} does not accept a reference`);
  throw new ReviewUsageError(`review ${action} requires exactly one reference`);
}

function assertActionOptions(action: ReviewAction, flags: ReviewCommandFlags): void {
  const hasSourceOption =
    flags.pr !== undefined ||
    flags.staged === true ||
    flags.unstaged === true ||
    flags.scope !== undefined;
  if (action !== 'create' && hasSourceOption) {
    throw new ReviewUsageError(`review ${action} does not accept a source selector`);
  }
  if (action !== 'create' && flags.exclude !== undefined) {
    throw new ReviewUsageError(`review ${action} does not accept --exclude`);
  }
  if (action !== 'create' && flags.explainRemovals !== undefined) {
    throw new ReviewUsageError(`review ${action} does not accept --explain-removals`);
  }
  if (action !== 'analysis-set' && action !== 'answer' && flags.bodyFile !== undefined) {
    throw new ReviewUsageError(`review ${action} does not accept --body-file`);
  }
  if (action !== 'wait' && flags.for !== undefined) {
    throw new ReviewUsageError(`review ${action} does not accept --for`);
  }
  if (action !== 'answer' && flags.review !== undefined) {
    throw new ReviewUsageError(`review ${action} does not accept --review`);
  }
  if (
    action !== 'create' &&
    action !== 'open' &&
    action !== 'status' &&
    action !== 'list' &&
    action !== 'analysis-set' &&
    flags.json === true
  ) {
    throw new ReviewUsageError(`review ${action} does not accept --json`);
  }
}

/** CAC parses both `--explain-removals` and `--no-explain-removals` into the same `explainRemovals`
 * key, with the later occurrence winning (or, depending on argument order, silently collapsing
 * into an array neither caller expects) - it never reports "both were given" on its own. This
 * inspects the raw argv directly so that usage error is caught explicitly instead of surfacing as
 * a confusing downstream value. */
function assertNoConflictingExplainRemovalsFlags(rawArgs: readonly string[]): void {
  if (rawArgs.includes('--explain-removals') && rawArgs.includes('--no-explain-removals')) {
    throw new ReviewUsageError('--explain-removals and --no-explain-removals cannot both be given');
  }
}

function parseUsageWorkspaceId(value: string): string {
  try {
    assertSafeReviewSegment(value, 'workspace');
    return value;
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'invalid workspace id';
    throw new ReviewUsageError(detail);
  }
}

function validateReviewCommand(
  actionValue: string,
  references: string[],
  flags: ReviewCommandFlags,
  monotonicNow: () => number = () => performance.now(),
  rawArgs: readonly string[] = [],
): ValidatedReviewCommand {
  assertKnownAction(actionValue);
  assertKnownOptions(flags);
  assertActionOptions(actionValue, flags);
  switch (actionValue) {
    case 'create':
      assertReferenceCount(actionValue, references, 0);
      assertNoConflictingExplainRemovalsFlags(rawArgs);
      return {
        action: actionValue,
        source: createReviewSourceFromFlags(flags),
        // Pass the tri-state straight through - see the field's doc comment. Coercing this with
        // `=== true` was the bug: it turned "flag omitted" into an explicit `false`, which
        // `createOrResumeReview` then applied as "turn the policy off" on every resumed
        // workspace, silently disabling a gate the reviewer had turned on.
        explainRemovals: flags.explainRemovals,
      };
    case 'refresh':
      assertReferenceCount(actionValue, references, 1);
      return { action: actionValue, workspaceId: parseUsageWorkspaceId(references[0] ?? '') };
    case 'analysis-set':
      assertReferenceCount(actionValue, references, 1);
      if (!flags.bodyFile) throw new ReviewUsageError('review analysis-set requires --body-file');
      {
        const parsingStartedAt = monotonicNow();
        const analysis = readUsageAnalysis(flags.bodyFile);
        const analysisParsingMs = monotonicNow() - parsingStartedAt;
        if (!Number.isFinite(analysisParsingMs) || analysisParsingMs < 0) {
          throw new ReviewUsageError('analysis parsing duration must be nonnegative');
        }
        return {
          action: actionValue,
          reference: parseUsageReviewRef(references[0] ?? ''),
          analysis,
          analysisParsingMs,
        };
      }
    case 'list':
      assertReferenceCount(actionValue, references, 0);
      return { action: actionValue };
    case 'open':
    case 'status':
      assertReferenceCount(actionValue, references, 1);
      return { action: actionValue, reference: parseUsageReviewRef(references[0] ?? '') };
    case 'wait': {
      assertReferenceCount(actionValue, references, 1);
      let timeoutMs: number | undefined;
      try {
        timeoutMs = flags.for ? parseDuration(flags.for) : undefined;
      } catch (error) {
        const detail = error instanceof Error ? error.message : 'invalid wait duration';
        throw new ReviewUsageError(detail);
      }
      return {
        action: actionValue,
        reference: parseUsageReviewRef(references[0] ?? ''),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      };
    }
    case 'answer': {
      assertReferenceCount(actionValue, references, 1);
      if (!flags.review) throw new ReviewUsageError('review answer requires --review');
      if (!flags.bodyFile) throw new ReviewUsageError('review answer requires --body-file');
      const questionId = references[0] ?? '';
      try {
        assertSafeReviewSegment(questionId, 'question');
      } catch (error) {
        const detail = error instanceof Error ? error.message : 'invalid question id';
        throw new ReviewUsageError(detail);
      }
      return {
        action: actionValue,
        questionId,
        reference: parseUsageReviewRef(flags.review),
        answerBody: readUsageAnswer(flags.bodyFile),
      };
    }
  }
}

export interface RunReviewWaitCommandOptions {
  root: string;
  reference: ReturnType<typeof parseReviewRef>;
  listenerId: string;
  timeoutMs?: number;
  wait?: typeof waitForReviewQuestions;
}

export async function runReviewWaitCommand(
  options: RunReviewWaitCommandOptions,
): Promise<{ result: ReviewWaitResult; interrupted: boolean }> {
  const { root, reference, listenerId, timeoutMs, wait = waitForReviewQuestions } = options;
  const controller = new AbortController();
  let interrupted = false;
  const onSignal = () => {
    interrupted = true;
    controller.abort();
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    const result = await wait({
      root,
      reference,
      listenerId,
      timeoutMs,
      signal: controller.signal,
    });
    return { result, interrupted };
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }
}

export function registerReviewCommands(cli: CAC, dependencies: ReviewCliDependencies = {}): void {
  const open = dependencies.openReview ?? openReview;
  const applyAnalysis = dependencies.applyReviewAnalysis ?? applyReviewAnalysis;
  const monotonicNow = dependencies.monotonicNow ?? (() => performance.now());
  cli
    .command('review <action> [...references]', 'Manage local guided code reviews')
    .option('--root <dir>', 'Project root (default: cwd)')
    .option('--pr <number-or-url>', 'GitHub PR number or URL')
    .option('--staged', 'Review the Git index')
    .option('--unstaged', 'Review tracked worktree and non-ignored untracked changes')
    .option(
      '--scope <path>',
      'Review tracked and non-ignored files under a repository-relative path',
    )
    .option(
      '--exclude <pattern>',
      'Repository-relative path pattern to exclude from the review (repeatable); create only',
    )
    .option(
      // `--no-explain-removals` is intentionally NOT declared as its own `.option()`: CAC
      // treats a declared `--no-x` as a distinct boolean option with its own implicit
      // `default: true` for `x`, which would make `explainRemovals` default to `true` on every
      // invocation that omits both flags - exactly the "no opinion" case this must NOT resolve
      // to a value. `mri`, the arg parser CAC delegates to, already recognizes an undeclared
      // `--no-` prefix as boolean negation on its own, so this single declaration is enough for
      // both spellings to parse correctly while keeping "neither given" as `undefined`.
      '--explain-removals',
      'Require a rationale for every detected removal run before analysis can finalize (default: off on first capture; unchanged on resume; use --no-explain-removals to turn off explicitly); create only',
    )
    .option('--json', 'Print machine-readable output')
    .option('--body-file <path>', 'Analysis or answer body file')
    .option('--for <duration>', 'Bounded question wait, e.g. 90s, 10m, 1h')
    .option('--review <reference>', 'Review reference for review answer')
    .allowUnknownOptions()
    .action(async (action: string, references: string[], flags: ReviewCommandFlags) => {
      try {
        const commandStartedAt = monotonicNow();
        const command = validateReviewCommand(action, references, flags, monotonicNow, cli.rawArgs);
        const root = resolveRepositoryRoot(flags.root ?? process.cwd());
        if (command.action === 'create') {
          printCreateResult(
            createOrResumeReview({
              root,
              source: requireValidatedValue(command.source),
              explainRemovals: command.explainRemovals,
            }),
            flags.json,
          );
          return;
        }
        if (command.action === 'refresh') {
          printCreateResult(
            refreshReview({ root, workspaceId: requireValidatedValue(command.workspaceId) }),
            flags.json,
          );
          return;
        }
        if (command.action === 'analysis-set') {
          const result = await applyAnalysis(
            {
              root,
              reference: requireValidatedValue(command.reference),
              analysis: requireValidatedValue(command.analysis),
              parsingInMs: command.analysisParsingMs,
              commandStartedAt,
            },
            { monotonicNow },
          );
          if (flags.json) {
            process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
            return;
          }
          const destination = result.previewReady ? result.url : result.route;
          process.stdout.write(
            `${green('✓')} analysis recorded for ${bold(result.reference)}\n${dim('Analysis interval:')} ${result.analysisFinalizedInMs}ms\n${dim('Tool timing:')} ${result.timings.totalMs}ms\n${dim(result.previewReady ? 'Open:' : 'Route:')} ${destination}\n`,
          );
          return;
        }
        if (command.action === 'list') {
          const workspaces = listReviews(root);
          if (flags.json) {
            process.stdout.write(`${JSON.stringify(workspaces, null, 2)}\n`);
            return;
          }
          if (workspaces.length === 0) {
            process.stdout.write(`${dim('No local review workspaces found.')}\n`);
            return;
          }
          for (const workspace of workspaces) {
            process.stdout.write(
              `${bold(workspace.id)} ${dim('›')} ${workspace.currentRevisionId} ${yellow(workspace.source.kind)}\n`,
            );
          }
          return;
        }
        if (command.action === 'open') {
          const reference = requireValidatedValue(command.reference);
          const url = await open(root, reference);
          process.stdout.write(
            flags.json ? `${JSON.stringify({ reference: references[0], url })}\n` : `${url}\n`,
          );
          return;
        }
        if (command.action === 'status') {
          const reviewRef = requireValidatedValue(command.reference);
          process.stdout.write(
            `${flags.json ? formatReviewStatusJson({ root, reference: reviewRef }) : printReviewStatus({ root, reference: reviewRef })}\n`,
          );
          return;
        }
        if (command.action === 'wait') {
          const reference = requireValidatedValue(command.reference);
          const listenerId = randomUUID();
          const { result, interrupted } = await runReviewWaitCommand({
            root,
            reference,
            listenerId,
            timeoutMs: command.timeoutMs,
          });
          if (interrupted) {
            process.exitCode = 130;
            return;
          }
          process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
          return;
        }
        if (command.action === 'answer') {
          const reference = requireValidatedValue(command.reference);
          const questionId = requireValidatedValue(command.questionId);
          const listenerId = randomUUID();
          const now = Date.now();
          const claim = claimQuestion(root, reference, questionId, listenerId, now, 5 * 60_000);
          const claimToken = claim.question?.claim?.token;
          if (!claim.ok || !claimToken)
            throw new Error('review question is already claimed or answered');
          try {
            const answer = writeAnswer(
              root,
              reference,
              questionId,
              listenerId,
              claimToken,
              requireValidatedValue(command.answerBody),
              Date.now(),
            );
            process.stdout.write(
              `${JSON.stringify({ question: answer.questionId, answer }, null, 2)}\n`,
            );
          } catch (error) {
            failQuestion(
              root,
              reference,
              questionId,
              listenerId,
              claimToken,
              'Answer generation failed.',
              Date.now(),
            );
            throw error;
          }
          return;
        }
      } catch (error) {
        printError(error, error instanceof ReviewUsageError ? 2 : 1, flags.json);
      }
    });
}
