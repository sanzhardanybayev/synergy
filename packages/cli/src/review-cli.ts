import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  assertSafeReviewSegment,
  claimQuestion,
  failQuestion,
  parseReviewRef,
  writeAnswer,
} from '@synergy/review-core';
import type { ProposedCodeSection, ReviewInsightConfidence } from '@synergy/review-core';
import type { CAC } from 'cac';
import { bold, dim, green, red, yellow } from 'kleur/colors';
import { parseDuration } from './feedback-wait.js';
import {
  type ReviewAnalysis,
  applyReviewAnalysis,
  createOrResumeReview,
  formatReviewStatusJson,
  listReviews,
  openReview,
  printReviewStatus,
  refreshReview,
} from './review-actions.js';
import { type ReviewCaptureSourceRequest, resolveRepositoryRoot } from './review-capture.js';
import { type ReviewWaitResult, waitForReviewQuestions } from './review-wait.js';

interface ReviewCreateFlags {
  root?: string;
  pr?: string;
  staged?: boolean;
  unstaged?: boolean;
  scope?: string;
  json?: boolean;
}

interface ReviewCommandFlags extends ReviewCreateFlags {
  bodyFile?: string;
  for?: string;
  review?: string;
  '--'?: string[];
  [key: string]: unknown;
}

export class ReviewUsageError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isReviewInsightConfidence(value: unknown): value is ReviewInsightConfidence {
  return value === 'high' || value === 'medium' || value === 'low';
}

function isIntegerNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

function readAnalysis(body: string): ReviewAnalysis {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new Error('analysis body must contain valid JSON');
  }
  if (!isRecord(value) || !Array.isArray(value.groups) || !Array.isArray(value.items)) {
    throw new Error('analysis body must include groups and items arrays');
  }
  const groups = value.groups.map((group) => {
    if (
      !isRecord(group) ||
      typeof group.id !== 'string' ||
      typeof group.label !== 'string' ||
      !Array.isArray(group.reviewItemIds) ||
      !group.reviewItemIds.every((item) => typeof item === 'string')
    ) {
      throw new Error('analysis groups must contain id, label, and reviewItemIds');
    }
    return { id: group.id, label: group.label, reviewItemIds: group.reviewItemIds };
  });
  const items = value.items.map((item) => {
    if (
      !isRecord(item) ||
      typeof item.reviewItemId !== 'string' ||
      typeof item.description !== 'string' ||
      !isReviewInsightConfidence(item.confidence) ||
      !Array.isArray(item.evidencePaths) ||
      !item.evidencePaths.every((path) => typeof path === 'string')
    ) {
      throw new Error(
        'analysis items must contain reviewItemId, description, confidence, and evidencePaths',
      );
    }
    const confidence = item.confidence;
    return {
      reviewItemId: item.reviewItemId,
      description: item.description,
      confidence,
      evidencePaths: item.evidencePaths,
    };
  });
  let sections: ProposedCodeSection[] | undefined;
  if (value.sections !== undefined) {
    if (!Array.isArray(value.sections)) throw new Error('analysis sections must be an array');
    sections = value.sections.map((section) => {
      if (
        !isRecord(section) ||
        typeof section.path !== 'string' ||
        typeof section.label !== 'string' ||
        !isIntegerNumber(section.start) ||
        !isIntegerNumber(section.end) ||
        (section.parentLabel !== undefined && typeof section.parentLabel !== 'string')
      ) {
        throw new Error('analysis sections must contain path, label, start, and end');
      }
      return {
        path: section.path,
        label: section.label,
        start: section.start,
        end: section.end,
        ...(section.parentLabel === undefined ? {} : { parentLabel: section.parentLabel }),
      };
    });
  }
  return { groups, items, ...(sections === undefined ? {} : { sections }) };
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
  if (flags.pr !== undefined) return { kind: 'pr', selector: flags.pr };
  if (flags.staged) return { kind: 'staged' };
  if (flags.unstaged) return { kind: 'unstaged' };
  if (!flags.scope || flags.scope.trim().length === 0) {
    throw new ReviewUsageError('--scope cannot be empty');
  }
  return { kind: 'scope', patterns: [flags.scope] };
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
  process.stdout.write(
    `${green('✓')} ${bold(reference)} ${dim(result.resumed ? 'resumed' : 'created')}\n${dim('Preparation:')} ${preparation}\n${dim('Open:')} ${result.url}\n`,
  );
}

function printError(error: unknown, exitCode: number): void {
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

function readUsageAnalysis(path: string): ReviewAnalysis {
  try {
    return readAnalysis(readFileSync(path, 'utf8'));
  } catch (error) {
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
  workspaceId?: string;
  reference?: ReturnType<typeof parseReviewRef>;
  analysis?: ReviewAnalysis;
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
  if (action !== 'analysis-set' && action !== 'answer' && flags.bodyFile !== undefined) {
    throw new ReviewUsageError(`review ${action} does not accept --body-file`);
  }
  if (action !== 'wait' && flags.for !== undefined) {
    throw new ReviewUsageError(`review ${action} does not accept --for`);
  }
  if (action !== 'answer' && flags.review !== undefined) {
    throw new ReviewUsageError(`review ${action} does not accept --review`);
  }
  if (action !== 'create' && action !== 'status' && action !== 'list' && flags.json === true) {
    throw new ReviewUsageError(`review ${action} does not accept --json`);
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
): ValidatedReviewCommand {
  assertKnownAction(actionValue);
  assertKnownOptions(flags);
  assertActionOptions(actionValue, flags);
  switch (actionValue) {
    case 'create':
      assertReferenceCount(actionValue, references, 0);
      return { action: actionValue, source: createReviewSourceFromFlags(flags) };
    case 'refresh':
      assertReferenceCount(actionValue, references, 1);
      return { action: actionValue, workspaceId: parseUsageWorkspaceId(references[0] ?? '') };
    case 'analysis-set':
      assertReferenceCount(actionValue, references, 1);
      if (!flags.bodyFile) throw new ReviewUsageError('review analysis-set requires --body-file');
      return {
        action: actionValue,
        reference: parseUsageReviewRef(references[0] ?? ''),
        analysis: readUsageAnalysis(flags.bodyFile),
      };
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

export function registerReviewCommands(cli: CAC): void {
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
    .option('--json', 'Print machine-readable output')
    .option('--body-file <path>', 'Analysis or answer body file')
    .option('--for <duration>', 'Bounded question wait, e.g. 90s, 10m, 1h')
    .option('--review <reference>', 'Review reference for review answer')
    .allowUnknownOptions()
    .action(async (action: string, references: string[], flags: ReviewCommandFlags) => {
      try {
        const command = validateReviewCommand(action, references, flags);
        const root = resolveRepositoryRoot(flags.root ?? process.cwd());
        if (command.action === 'create') {
          printCreateResult(
            createOrResumeReview({ root, source: requireValidatedValue(command.source) }),
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
          applyReviewAnalysis({
            root,
            reference: requireValidatedValue(command.reference),
            analysis: requireValidatedValue(command.analysis),
          });
          process.stdout.write(
            `${green('✓')} analysis recorded for ${bold(references[0] ?? '')}\n`,
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
          const url = openReview(root, reference);
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
        printError(error, error instanceof ReviewUsageError ? 2 : 1);
      }
    });
}
