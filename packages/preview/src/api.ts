/**
 * Typed fetch client for all /api/* endpoints exposed by vite-plugin-edit.
 *
 * All endpoints are same-origin on the preview runtime's negotiated loopback origin. "file" paths are relative to
 * sessionsDir (e.g. "2026-05-25-foo/00-overview.mdx").
 *
 * Error modelling:
 *  - PUT /api/edit + PATCH /api/status: 409 → discriminated result with
 *    ok:false + reason. 404/400 also modelled as ok:false.
 *  - GET /api/diff + POST /api/review: not-a-git-repo modelled as
 *    { available: false }.
 *  - All other failures throw an Error with a descriptive message.
 */

// ---------------------------------------------------------------------------
// Shared coordinate types
// ---------------------------------------------------------------------------

import type {
  ReviewAnswer,
  ReviewBundle,
  ReviewItemProgressPatch,
  ReviewProgress,
  ReviewQuestion,
  ReviewReadiness,
  ReviewRef,
} from '@synergy/review-core';
import {
  deriveReviewReadiness,
  resolveBrowserReviewItemContext,
  stableReviewJson,
} from '@synergy/review-core/browser';
import type { AgentTreeNode } from '@synergy/spec-kit';

export class ReviewApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
    this.name = 'ReviewApiError';
  }
}

export interface ReviewBundleResponse {
  bundle: ReviewBundle;
  readiness: ReviewReadiness;
  analysisFinalized: boolean;
}

export interface ReviewQuestionResponse extends ReviewBundleResponse {
  question: ReviewQuestion;
}

export type ReviewStreamFrame =
  | { type: 'presence'; listening: boolean }
  | { type: 'question'; question: ReviewQuestion }
  | { type: 'answer'; answer: ReviewAnswer }
  | {
      type: 'progress';
      progress: ReviewProgress;
      readiness: ReviewReadiness;
      analysisFinalized: boolean;
    }
  | { type: 'source'; changed: boolean; captureFailed: boolean }
  | {
      type: 'interruption';
      code: 'source_capture_failed' | 'stream_unavailable' | 'review_unavailable';
      recoverable: boolean;
    };

export interface ReviewStreamHandlers {
  onFrame(frame: ReviewStreamFrame, eventId: string): void;
  onOpen?(): void;
  onError?(): void;
}

export interface ReviewStreamConnection {
  close(): void;
}

export interface ReviewEventSource {
  close(): void;
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void;
  onopen: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
}

export type ReviewEventSourceFactory = (url: string) => ReviewEventSource;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function reviewPath(reference: ReviewRef, suffix = ''): string {
  const base = `/api/reviews/${encodeURIComponent(reference.workspaceId)}/${encodeURIComponent(reference.revisionId)}`;
  return suffix ? `${base}/${suffix}` : base;
}

function sanitizeServerCode(value: unknown): string {
  const code = readString(isRecord(value) ? value.error : undefined);
  return code && /^[a-z0-9_]+$/u.test(code) ? code : 'request_failed';
}

async function reviewError(response: Response): Promise<ReviewApiError> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = undefined;
  }
  return new ReviewApiError(response.status, sanitizeServerCode(payload));
}

async function readReviewJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new Error('invalid review response');
  }
}

function assertReadiness(value: unknown): asserts value is ReviewReadiness {
  if (!isRecord(value)) throw new Error('invalid review response');
  const pending = value.pending;
  const stale = value.stale;
  const unanswered = value.unanswered;
  if (
    typeof value.ready !== 'boolean' ||
    typeof value.preparing !== 'boolean' ||
    typeof pending !== 'number' ||
    !Number.isSafeInteger(pending) ||
    pending < 0 ||
    typeof stale !== 'number' ||
    !Number.isSafeInteger(stale) ||
    stale < 0 ||
    typeof unanswered !== 'number' ||
    !Number.isSafeInteger(unanswered) ||
    unanswered < 0 ||
    typeof value.sourceChanged !== 'boolean'
  ) {
    throw new Error('invalid review response');
  }
}

function sameJson(left: unknown, right: unknown): boolean {
  return stableReviewJson(left) === stableReviewJson(right);
}

function assertString(value: unknown): asserts value is string {
  if (typeof value !== 'string') throw new Error('invalid review response');
}

function assertNonEmptyString(value: unknown): asserts value is string {
  assertString(value);
  if (value.length === 0) throw new Error('invalid review response');
}

function assertTimestamp(value: unknown): void {
  assertNonEmptyString(value);
  if (!Number.isFinite(Date.parse(value))) throw new Error('invalid review response');
}

function assertRecord(value: unknown): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw new Error('invalid review response');
}

function assertSource(value: unknown): void {
  assertRecord(value);
  assertNonEmptyString(value.kind);
  if (value.kind === 'pr') {
    if (typeof value.number !== 'number' || !Number.isInteger(value.number))
      throw new Error('invalid review response');
    for (const key of ['url', 'baseSha', 'headSha']) assertNonEmptyString(value[key]);
    return;
  }
  if (value.kind === 'scope') {
    if (!Array.isArray(value.patterns)) throw new Error('invalid review response');
    for (const pattern of value.patterns) assertNonEmptyString(pattern);
    assertNonEmptyString(value.headSha);
    return;
  }
  if (value.kind === 'staged' || value.kind === 'unstaged') {
    assertNonEmptyString(value.headSha);
    return;
  }
  throw new Error('invalid review response');
}

function assertItem(value: unknown): void {
  assertRecord(value);
  if (value.kind !== 'hunk' && value.kind !== 'code-section' && value.kind !== 'file')
    throw new Error('invalid review response');
  for (const key of ['id', 'path', 'label', 'contentHash', 'locationHash'])
    assertNonEmptyString(value[key]);
  assertRecord(value.range);
  const start = value.range.start;
  const end = value.range.end;
  if (
    typeof start !== 'number' ||
    typeof end !== 'number' ||
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 1 ||
    end < 1 ||
    start > end
  )
    throw new Error('invalid review response');
}

function assertItemContext(value: unknown): void {
  assertRecord(value);
  assertItem(value.item);
  if (!Array.isArray(value.rows)) throw new Error('invalid review response');
  for (const row of value.rows) {
    assertRecord(row);
    assertNonEmptyString(row.id);
    assertNonEmptyString(row.kind);
    assertString(row.text);
    if (row.kind === 'scope') {
      if (!Number.isInteger(row.line)) throw new Error('invalid review response');
    } else if (row.kind === 'context' || row.kind === 'add' || row.kind === 'remove') {
      if (
        (row.oldLine !== null && !Number.isInteger(row.oldLine)) ||
        (row.newLine !== null && !Number.isInteger(row.newLine))
      )
        throw new Error('invalid review response');
    } else throw new Error('invalid review response');
  }
}

function assertQuestion(value: unknown): asserts value is ReviewQuestion {
  assertRecord(value);
  if (value.schemaVersion !== 1) throw new Error('invalid review response');
  for (const key of [
    'id',
    'workspaceId',
    'revisionId',
    'path',
    'reviewItemId',
    'body',
    'createdAt',
    'status',
  ]) {
    assertNonEmptyString(value[key]);
  }
  assertString(value.description);
  const status = readString(value.status);
  if (!status || !['queued', 'processing', 'answered', 'failed', 'stale'].includes(status)) {
    throw new Error('invalid review response');
  }
  if (
    typeof value.generation !== 'number' ||
    !Number.isInteger(value.generation) ||
    value.generation < 0
  ) {
    throw new Error('invalid review response');
  }
  assertRecord(value.selection);
  if (
    (value.selection.kind !== 'diff' && value.selection.kind !== 'scope') ||
    !Array.isArray(value.selection.selectedLineIds)
  ) {
    throw new Error('invalid review response');
  }
  for (const id of value.selection.selectedLineIds) assertNonEmptyString(id);
  if (
    value.selection.selectedLineIds.length === 0 ||
    new Set(value.selection.selectedLineIds).size !== value.selection.selectedLineIds.length
  ) {
    throw new Error('invalid review response');
  }
  assertItemContext(value.itemContext);
  assertTimestamp(value.createdAt);
  if (value.claim !== undefined) {
    assertRecord(value.claim);
    for (const key of ['listenerId', 'token']) assertNonEmptyString(value.claim[key]);
    for (const key of ['claimedAt', 'expiresAt']) assertTimestamp(value.claim[key]);
  }
  if (value.failureMessage !== undefined) assertString(value.failureMessage);
}

function assertAnswer(value: unknown): asserts value is ReviewAnswer {
  assertRecord(value);
  if (value.schemaVersion !== 1) throw new Error('invalid review response');
  for (const key of [
    'id',
    'questionId',
    'workspaceId',
    'revisionId',
    'listenerId',
    'body',
    'createdAt',
  ]) {
    assertNonEmptyString(value[key]);
  }
  assertTimestamp(value.createdAt);
}

function assertProgress(value: unknown): asserts value is ReviewProgress {
  assertRecord(value);
  if (value.schemaVersion !== 1 || !isRecord(value.items)) {
    throw new Error('invalid review response');
  }
  assertTimestamp(value.updatedAt);
  for (const [itemId, progress] of Object.entries(value.items)) {
    assertNonEmptyString(itemId);
    assertRecord(progress);
    if (
      !['needs-review', 'reviewed', 'carried-forward', 'stale'].includes(
        readString(progress.status) ?? '',
      )
    ) {
      throw new Error('invalid review response');
    }
    if (progress.note !== undefined) assertString(progress.note);
    if (progress.reviewedAt !== undefined) assertTimestamp(progress.reviewedAt);
    if (progress.inheritedFrom !== undefined) {
      assertRecord(progress.inheritedFrom);
      assertNonEmptyString(progress.inheritedFrom.revisionId);
      assertNonEmptyString(progress.inheritedFrom.reviewItemId);
    }
  }
}

function assertBundle(value: unknown): asserts value is ReviewBundle {
  assertRecord(value);
  assertRecord(value.workspace);
  assertRecord(value.workspace.repository);
  assertRecord(value.workspace.source);
  if (value.workspace.schemaVersion !== 1) throw new Error('invalid review response');
  for (const key of ['id', 'currentRevisionId', 'createdAt', 'updatedAt'])
    assertNonEmptyString(value.workspace[key]);
  for (const key of ['root', 'name']) assertNonEmptyString(value.workspace.repository[key]);
  assertSource(value.workspace.source);

  assertRecord(value.snapshot);
  if (value.snapshot.schemaVersion !== 1) throw new Error('invalid review response');
  for (const key of ['revisionId', 'fingerprint', 'createdAt', 'kind'])
    assertNonEmptyString(value.snapshot[key]);
  if (
    (value.snapshot.kind !== 'diff' && value.snapshot.kind !== 'scope') ||
    !Array.isArray(value.snapshot.items)
  ) {
    throw new Error('invalid review response');
  }
  assertSource(value.snapshot.source);
  for (const item of value.snapshot.items) assertItem(item);
  const itemIds = new Set<string>();
  for (const item of value.snapshot.items) {
    if (itemIds.has(item.id)) throw new Error('invalid review response');
    itemIds.add(item.id);
  }
  if (!Array.isArray(value.snapshot.files)) throw new Error('invalid review response');
  for (const file of value.snapshot.files) {
    assertRecord(file);
    assertNonEmptyString(file.path);
    if (typeof file.binary !== 'boolean') throw new Error('invalid review response');
    if (value.snapshot.kind === 'scope') {
      if (!Array.isArray(file.lines)) throw new Error('invalid review response');
      for (const line of file.lines) {
        assertRecord(line);
        if (!Number.isInteger(line.number)) throw new Error('invalid review response');
        assertString(line.text);
      }
    } else {
      if (
        !['added', 'deleted', 'modified', 'renamed', 'copied', 'binary'].includes(
          readString(file.status) ?? '',
        ) ||
        !Number.isInteger(file.additions) ||
        !Number.isInteger(file.deletions) ||
        !Array.isArray(file.hunks)
      )
        throw new Error('invalid review response');
      for (const key of [
        'reviewItemId',
        'reviewItemContentHash',
        'reviewItemLocationHash',
        'previousPath',
        'oldMode',
        'newMode',
        'binaryPatchHash',
      ]) {
        if (file[key] !== undefined) assertNonEmptyString(file[key]);
      }
      if (file.binary && file.binaryPatchHash === undefined) {
        throw new Error('invalid review response');
      }
      for (const hunk of file.hunks) {
        assertRecord(hunk);
        assertNonEmptyString(hunk.reviewItemId);
        assertNonEmptyString(hunk.reviewItemContentHash);
        assertNonEmptyString(hunk.reviewItemLocationHash);
        if (!itemIds.has(hunk.reviewItemId)) throw new Error('invalid review response');
        for (const key of ['header', 'oldStart', 'oldLines', 'newStart', 'newLines']) {
          if (key === 'header') assertNonEmptyString(hunk[key]);
          else if (!Number.isInteger(hunk[key])) throw new Error('invalid review response');
        }
        if (!Array.isArray(hunk.lines)) throw new Error('invalid review response');
        for (const line of hunk.lines) {
          assertRecord(line);
          if (!['context', 'add', 'remove'].includes(readString(line.kind) ?? '')) {
            throw new Error('invalid review response');
          }
          assertString(line.text);
          if (
            (line.oldLine !== null && !Number.isInteger(line.oldLine)) ||
            (line.newLine !== null && !Number.isInteger(line.newLine))
          ) {
            throw new Error('invalid review response');
          }
        }
      }
    }
  }
  assertRecord(value.insights);
  if (
    value.insights.schemaVersion !== 1 ||
    !Array.isArray(value.insights.groups) ||
    !Array.isArray(value.insights.items)
  ) {
    throw new Error('invalid review response');
  }
  assertNonEmptyString(value.insights.revisionId);
  for (const group of value.insights.groups) {
    assertRecord(group);
    assertNonEmptyString(group.id);
    assertNonEmptyString(group.label);
    if (!Array.isArray(group.reviewItemIds)) throw new Error('invalid review response');
    for (const id of group.reviewItemIds) assertNonEmptyString(id);
  }
  for (const insight of value.insights.items) {
    assertRecord(insight);
    assertNonEmptyString(insight.reviewItemId);
    assertString(insight.description);
    if (
      !['high', 'medium', 'low'].includes(readString(insight.confidence) ?? '') ||
      !Array.isArray(insight.evidencePaths)
    )
      throw new Error('invalid review response');
    for (const path of insight.evidencePaths) assertNonEmptyString(path);
  }
  assertProgress(value.progress);
  if (!Array.isArray(value.questions) || !Array.isArray(value.answers))
    throw new Error('invalid review response');
  for (const question of value.questions) assertQuestion(question);
  for (const answer of value.answers) assertAnswer(answer);
  for (const question of value.questions) {
    if (!itemIds.has(question.reviewItemId) || !itemIds.has(question.itemContext.item.id)) {
      throw new Error('invalid review response');
    }
  }
  const questionIds = new Set(value.questions.map((question) => question.id));
  if (questionIds.size !== value.questions.length) throw new Error('invalid review response');
  if (new Set(value.answers.map((answer) => answer.id)).size !== value.answers.length) {
    throw new Error('invalid review response');
  }
  if (value.answers.some((answer) => !questionIds.has(answer.questionId))) {
    throw new Error('invalid review response');
  }
  for (const progressItemId of Object.keys(value.progress.items)) {
    if (!itemIds.has(progressItemId)) throw new Error('invalid review response');
  }
  if (typeof value.sourceChanged !== 'boolean') throw new Error('invalid review response');
}

function assertBundleRelationships(bundle: ReviewBundle): void {
  if (
    bundle.insights.revisionId !== bundle.snapshot.revisionId ||
    !sameJson(bundle.workspace.source, bundle.snapshot.source)
  ) {
    throw new Error('invalid review response');
  }
  const itemIds = new Set(bundle.snapshot.items.map((item) => item.id));
  if (
    bundle.insights.groups.some((group) =>
      group.reviewItemIds.some((reviewItemId) => !itemIds.has(reviewItemId)),
    ) ||
    bundle.insights.items.some((insight) => !itemIds.has(insight.reviewItemId)) ||
    Object.keys(bundle.progress.items).some((reviewItemId) => !itemIds.has(reviewItemId))
  ) {
    throw new Error('invalid review response');
  }
  if (bundle.snapshot.kind === 'diff') {
    const linkedItemIds = new Set<string>();
    for (const file of bundle.snapshot.files) {
      if (file.hunks.length > 0) {
        if (
          file.reviewItemId !== undefined ||
          file.reviewItemContentHash !== undefined ||
          file.reviewItemLocationHash !== undefined
        ) {
          throw new Error('invalid review response');
        }
        for (const hunk of file.hunks) {
          if (!hunk.reviewItemId || linkedItemIds.has(hunk.reviewItemId)) {
            throw new Error('invalid review response');
          }
          const item = bundle.snapshot.items.find(
            (candidate) => candidate.id === hunk.reviewItemId,
          );
          if (!item || item.kind !== 'hunk' || item.path !== file.path) {
            throw new Error('invalid review response');
          }
          linkedItemIds.add(item.id);
          resolveBrowserReviewItemContext(bundle.snapshot, item.id);
        }
        continue;
      }
      if (!file.reviewItemId || linkedItemIds.has(file.reviewItemId)) {
        throw new Error('invalid review response');
      }
      const item = bundle.snapshot.items.find((candidate) => candidate.id === file.reviewItemId);
      if (!item || item.kind !== 'file' || item.path !== file.path) {
        throw new Error('invalid review response');
      }
      linkedItemIds.add(item.id);
      resolveBrowserReviewItemContext(bundle.snapshot, item.id);
    }
    if (
      linkedItemIds.size !== bundle.snapshot.items.length ||
      bundle.snapshot.items.some((item) => !linkedItemIds.has(item.id))
    ) {
      throw new Error('invalid review response');
    }
  } else {
    for (const item of bundle.snapshot.items) {
      if (item.kind !== 'code-section') throw new Error('invalid review response');
      resolveBrowserReviewItemContext(bundle.snapshot, item.id);
    }
  }
  const questionIds = new Set(bundle.questions.map((question) => question.id));
  if (
    bundle.answers.some(
      (answer) =>
        !questionIds.has(answer.questionId) ||
        answer.workspaceId !== bundle.workspace.id ||
        answer.revisionId !== bundle.snapshot.revisionId,
    )
  ) {
    throw new Error('invalid review response');
  }
  for (const question of bundle.questions) {
    if (
      question.itemContext.item.id !== question.reviewItemId ||
      question.itemContext.item.path !== question.path ||
      question.selection.kind !== bundle.snapshot.kind
    ) {
      throw new Error('invalid review response');
    }
    const canonical = resolveBrowserReviewItemContext(bundle.snapshot, question.reviewItemId);
    if (
      !sameJson(question.itemContext, canonical) ||
      question.selection.selectedLineIds.some(
        (selectedLineId) => !canonical.rows.some((row) => row.id === selectedLineId),
      )
    ) {
      throw new Error('invalid review response');
    }
  }
}

function decodeBundle(value: unknown, reference: ReviewRef): ReviewBundleResponse {
  if (!isRecord(value) || !isRecord(value.bundle)) throw new Error('invalid review response');
  const { bundle } = value;
  try {
    assertBundle(bundle);
    assertBundleRelationships(bundle);
    assertReadiness(value.readiness);
    if (typeof value.analysisFinalized !== 'boolean') {
      throw new Error('invalid review response');
    }
    if (
      bundle.workspace.id !== reference.workspaceId ||
      bundle.snapshot.revisionId !== reference.revisionId ||
      bundle.workspace.currentRevisionId !== reference.revisionId ||
      bundle.questions.some(
        (question) =>
          question.workspaceId !== reference.workspaceId ||
          question.revisionId !== reference.revisionId,
      ) ||
      bundle.answers.some(
        (answer) =>
          answer.workspaceId !== reference.workspaceId ||
          answer.revisionId !== reference.revisionId,
      )
    ) {
      throw new Error('invalid review response');
    }
    if (!sameJson(value.readiness, deriveReviewReadiness(bundle, value.analysisFinalized))) {
      throw new Error('invalid review response');
    }
  } catch {
    throw new Error('invalid review response');
  }
  return {
    bundle: {
      workspace: bundle.workspace,
      snapshot: bundle.snapshot,
      insights: bundle.insights,
      progress: bundle.progress,
      questions: bundle.questions,
      answers: bundle.answers,
      sourceChanged: bundle.sourceChanged,
    },
    readiness: value.readiness,
    analysisFinalized: value.analysisFinalized,
  };
}

function decodeQuestionResponse(
  value: unknown,
  reference: ReviewRef,
  reviewItemId: string,
): ReviewQuestionResponse {
  const decoded = decodeBundle(value, reference);
  if (!isRecord(value)) throw new Error('invalid review response');
  const question = value.question;
  try {
    assertQuestion(question);
    if (
      question.workspaceId !== reference.workspaceId ||
      question.revisionId !== reference.revisionId ||
      question.reviewItemId !== reviewItemId
    ) {
      throw new Error('invalid review response');
    }
    const bundledQuestion = decoded.bundle.questions.find((bundled) => bundled.id === question.id);
    if (!bundledQuestion || !sameJson(bundledQuestion, question)) {
      throw new Error('invalid review response');
    }
    return { ...decoded, question };
  } catch {
    throw new Error('invalid review response');
  }
}

function decodeStreamFrame(value: unknown, reference: ReviewRef): ReviewStreamFrame {
  if (!isRecord(value) || typeof value.type !== 'string')
    throw new Error('invalid review stream frame');
  try {
    switch (value.type) {
      case 'presence':
        if (typeof value.listening !== 'boolean') break;
        return { type: 'presence', listening: value.listening };
      case 'question':
        assertQuestion(value.question);
        if (
          value.question.workspaceId !== reference.workspaceId ||
          value.question.revisionId !== reference.revisionId
        ) {
          break;
        }
        return { type: 'question', question: value.question };
      case 'answer':
        assertAnswer(value.answer);
        if (
          value.answer.workspaceId !== reference.workspaceId ||
          value.answer.revisionId !== reference.revisionId
        ) {
          break;
        }
        return { type: 'answer', answer: value.answer };
      case 'progress':
        assertProgress(value.progress);
        assertReadiness(value.readiness);
        if (typeof value.analysisFinalized !== 'boolean') break;
        return {
          type: 'progress',
          progress: value.progress,
          readiness: value.readiness,
          analysisFinalized: value.analysisFinalized,
        };
      case 'source':
        if (typeof value.changed !== 'boolean' || typeof value.captureFailed !== 'boolean') break;
        return { type: 'source', changed: value.changed, captureFailed: value.captureFailed };
      case 'interruption':
        if (
          (value.code === 'source_capture_failed' ||
            value.code === 'stream_unavailable' ||
            value.code === 'review_unavailable') &&
          typeof value.recoverable === 'boolean'
        ) {
          return { type: 'interruption', code: value.code, recoverable: value.recoverable };
        }
        break;
    }
  } catch {
    // The public error below deliberately avoids schema implementation details.
  }
  throw new Error('invalid review stream frame');
}

export async function getReviewBundle(
  reference: ReviewRef,
  signal?: AbortSignal,
): Promise<ReviewBundleResponse> {
  const response = await fetch(reviewPath(reference), { signal });
  if (!response.ok) throw await reviewError(response);
  return decodeBundle(await readReviewJson(response), reference);
}

export async function patchReviewProgress(
  reference: ReviewRef,
  reviewItemId: string,
  patch: ReviewItemProgressPatch,
  signal?: AbortSignal,
): Promise<ReviewBundleResponse> {
  const response = await fetch(reviewPath(reference, 'progress'), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reviewItemId, ...patch }),
    signal,
  });
  if (!response.ok) throw await reviewError(response);
  return decodeBundle(await readReviewJson(response), reference);
}

export async function postReviewQuestion(
  reference: ReviewRef,
  reviewItemId: string,
  selectedLineIds: string[],
  body: string,
  signal?: AbortSignal,
): Promise<ReviewQuestionResponse> {
  const response = await fetch(reviewPath(reference, 'questions'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reviewItemId, selectedLineIds, body }),
    signal,
  });
  if (!response.ok) throw await reviewError(response);
  return decodeQuestionResponse(await readReviewJson(response), reference, reviewItemId);
}

export async function postActiveReview(reference: ReviewRef, signal?: AbortSignal): Promise<void> {
  const response = await fetch(reviewPath(reference, 'active'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
    signal,
  });
  if (!response.ok) throw await reviewError(response);
  const value = await readReviewJson(response);
  if (!isRecord(value) || !isRecord(value.pointer)) throw new Error('invalid review response');
  const pointer = value.pointer;
  if (
    pointer.schemaVersion !== 1 ||
    typeof pointer.workspaceId !== 'string' ||
    typeof pointer.revisionId !== 'string' ||
    typeof pointer.updatedAt !== 'string'
  ) {
    throw new Error('invalid review response');
  }
  if (
    pointer.workspaceId !== reference.workspaceId ||
    pointer.revisionId !== reference.revisionId
  ) {
    throw new Error('invalid review response');
  }
}

/** Opens a typed SSE connection. Invalid frames are ignored at this boundary. */
export function openReviewStream(
  reference: ReviewRef,
  handlers: ReviewStreamHandlers,
  createEventSource: ReviewEventSourceFactory = (url) => new EventSource(url),
): ReviewStreamConnection {
  const source = createEventSource(reviewPath(reference, 'stream'));
  const receive = (event: MessageEvent<string>): void => {
    try {
      handlers.onFrame(decodeStreamFrame(JSON.parse(event.data), reference), event.lastEventId);
    } catch {
      // A malformed event cannot overwrite durable state already shown to the reviewer.
    }
  };
  for (const eventType of [
    'presence',
    'question',
    'answer',
    'progress',
    'source',
    'interruption',
  ]) {
    source.addEventListener(eventType, receive);
  }
  source.onopen = () => handlers.onOpen?.();
  source.onerror = () => handlers.onError?.();
  return { close: () => source.close() };
}

export interface LineCol {
  line: number; // 1-indexed
  col: number; // 0-indexed
}

// ---------------------------------------------------------------------------
// PUT /api/edit
// ---------------------------------------------------------------------------

export interface EditRequest {
  file: string;
  sourceStart: LineCol;
  sourceEnd: LineCol;
  expectedText: string;
  newText: string;
}

export type EditResult =
  | { ok: true; newSize: number }
  | { ok: false; reason: 'stale_range'; currentText: string }
  | { ok: false; reason: 'not_found' | 'bad_request' | 'error'; detail?: string };

export async function putEdit(req: EditRequest): Promise<EditResult> {
  const res = await fetch('/api/edit', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });

  if (res.status === 200) {
    const data = (await res.json()) as { ok: boolean; newSize: number };
    return { ok: true, newSize: data.newSize };
  }

  if (res.status === 409) {
    const data = (await res.json()) as { error: string; currentText?: string };
    return { ok: false, reason: 'stale_range', currentText: data.currentText ?? '' };
  }

  if (res.status === 404) {
    return { ok: false, reason: 'not_found' };
  }

  if (res.status === 400) {
    const data = (await res.json()) as { error?: string };
    return { ok: false, reason: 'bad_request', detail: data.error };
  }

  const text = await res.text();
  return { ok: false, reason: 'error', detail: text };
}

// ---------------------------------------------------------------------------
// PATCH /api/status
// ---------------------------------------------------------------------------

export type StatusRequest =
  | { kind: 'phase-frontmatter'; file: string; newStatus: string }
  | {
      kind: 'inline-status';
      file: string;
      sourceStart: LineCol;
      sourceEnd: LineCol;
      expectedText: string;
      newStatus: string;
    };

export type StatusResult =
  | { ok: true }
  | { ok: false; reason: 'stale_range'; currentText: string }
  | { ok: false; reason: 'not_found' | 'bad_request' | 'error'; detail?: string };

export async function patchStatus(req: StatusRequest): Promise<StatusResult> {
  const res = await fetch('/api/status', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });

  if (res.status === 200) {
    return { ok: true };
  }

  if (res.status === 409) {
    const data = (await res.json()) as { error: string; currentText?: string };
    return { ok: false, reason: 'stale_range', currentText: data.currentText ?? '' };
  }

  if (res.status === 404) {
    return { ok: false, reason: 'not_found' };
  }

  if (res.status === 400) {
    const data = (await res.json()) as { error?: string };
    return { ok: false, reason: 'bad_request', detail: data.error };
  }

  const text = await res.text();
  return { ok: false, reason: 'error', detail: text };
}

// ---------------------------------------------------------------------------
// POST /api/feedback
// ---------------------------------------------------------------------------

export interface CommentAnchor {
  lineStart: number;
  colStart: number;
  lineEnd: number;
  colEnd: number;
  before: string;
  selected: string;
  after: string;
}

export interface FeedbackPostRequest {
  session: string;
  file: string;
  anchor: CommentAnchor;
  body: string;
}

export interface FeedbackPostResponse {
  id: string;
  path: string;
}

export async function postFeedback(req: FeedbackPostRequest): Promise<FeedbackPostResponse> {
  const res = await fetch('/api/feedback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`POST /api/feedback failed (${res.status}): ${text}`);
  }

  return (await res.json()) as FeedbackPostResponse;
}

// ---------------------------------------------------------------------------
// GET /api/feedback
// ---------------------------------------------------------------------------

export type CommentStatus = 'open' | 'resolved' | 'rejected';

export interface Comment {
  id: string;
  session: string;
  file: string;
  status: CommentStatus;
  created: string;
  anchor: CommentAnchor;
  body: string;
  resolution?: string;
  rejection_reason?: string;
  resolved_at?: string;
  rejected_at?: string;
}

export interface FeedbackListResponse {
  comments: Comment[];
}

export async function listFeedback(session: string): Promise<FeedbackListResponse> {
  const res = await fetch(`/api/feedback?session=${encodeURIComponent(session)}`);

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GET /api/feedback failed (${res.status}): ${text}`);
  }

  return (await res.json()) as FeedbackListResponse;
}

// ---------------------------------------------------------------------------
// PATCH /api/feedback/:id
// ---------------------------------------------------------------------------

export type FeedbackPatchRequest =
  | { status: 'resolved'; resolution: string }
  | { status: 'rejected'; rejection_reason: string };

export async function patchFeedback(id: string, req: FeedbackPatchRequest): Promise<void> {
  const res = await fetch(`/api/feedback/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PATCH /api/feedback/${id} failed (${res.status}): ${text}`);
  }
}

// ---------------------------------------------------------------------------
// GET /api/diff
// ---------------------------------------------------------------------------

export interface DiffLine {
  kind: 'context' | 'add' | 'remove';
  text: string;
}

export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export interface DiffData {
  available: true;
  file: string;
  head: string;
  reviewedAt: string | null;
  hunks: Hunk[];
  uncommittedHunks: Hunk[];
}

export type DiffResult = DiffData | { available: false };

export async function getDiff(file: string): Promise<DiffResult> {
  const res = await fetch(`/api/diff?file=${encodeURIComponent(file)}`);

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GET /api/diff failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as { error?: string } & Partial<DiffData>;

  if (data.error === 'not_a_git_repo') {
    return { available: false };
  }

  return {
    available: true,
    file: data.file ?? file,
    head: data.head ?? '',
    reviewedAt: data.reviewedAt ?? null,
    hunks: data.hunks ?? [],
    uncommittedHunks: data.uncommittedHunks ?? [],
  };
}

// ---------------------------------------------------------------------------
// POST /api/review
// ---------------------------------------------------------------------------

export interface ReviewData {
  available: true;
  ok: true;
  reviewedAt: string;
  warn?: 'uncommitted_changes_present';
}

export type ReviewResult = ReviewData | { available: false };

export async function postReview(file: string): Promise<ReviewResult> {
  const res = await fetch('/api/review', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`POST /api/review failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as {
    error?: string;
    ok?: boolean;
    reviewedAt?: string;
    warn?: string;
  };

  if (data.error === 'not_a_git_repo') {
    return { available: false };
  }

  return {
    available: true,
    ok: true,
    reviewedAt: data.reviewedAt ?? '',
    ...(data.warn === 'uncommitted_changes_present'
      ? { warn: 'uncommitted_changes_present' as const }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// GET /api/source
// ---------------------------------------------------------------------------

export interface SourceResponse {
  file: string;
  source: string;
}

/** Fetch the raw MDX source text for a sessionsDir-relative file path. */
export async function getSource(file: string): Promise<string> {
  const res = await fetch(`/api/source?file=${encodeURIComponent(file)}`);

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GET /api/source failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as SourceResponse;
  return data.source;
}

// ---------------------------------------------------------------------------
// PUT /api/agent-tree
// ---------------------------------------------------------------------------

export type AgentTreeResult = { ok: true } | { ok: false; reason: string; detail?: string };

export async function putAgentTree(body: {
  file: string;
  tree: AgentTreeNode[];
}): Promise<AgentTreeResult> {
  const res = await fetch('/api/agent-tree', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json() as Promise<AgentTreeResult>;
}

// ---------------------------------------------------------------------------
// POST /api/active-session
// ---------------------------------------------------------------------------

export async function postActiveSession(session: string): Promise<void> {
  const res = await fetch('/api/active-session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`POST /api/active-session failed (${res.status}): ${text}`);
  }
}

// ---------------------------------------------------------------------------
// POST /api/review-done
// ---------------------------------------------------------------------------

/**
 * Signal that the user finished this review round. Drops the review-done
 * control file so an agent blocked in `synergy feedback wait` ends its wait.
 */
export async function postReviewDone(session: string): Promise<void> {
  const res = await fetch('/api/review-done', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`POST /api/review-done failed (${res.status}): ${text}`);
  }
}

// ---------------------------------------------------------------------------
// GET /api/progress
// ---------------------------------------------------------------------------

export interface PhaseStateDto {
  slug: string;
  status: string;
  startedAt?: string;
  completedAt?: string;
  updatedAt?: string;
}
export interface ProgressDto {
  progress: {
    version: 1;
    overallStatus: string;
    resume: { nextPhase?: string; note?: string };
    phases: PhaseStateDto[];
  };
  derived: { done: number; total: number; percent: number };
  roster: { number: number; slug: string; title: string; status: string }[];
  phaseJournals: Record<string, string>;
  globalJournal: string | null;
}

export async function getProgress(session: string): Promise<ProgressDto> {
  const res = await fetch(`/api/progress?session=${encodeURIComponent(session)}`);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GET /api/progress failed (${res.status}): ${text}`);
  }
  return (await res.json()) as ProgressDto;
}

// ---------------------------------------------------------------------------
// GET /api/reviews
// ---------------------------------------------------------------------------

export type ReviewIndexSourceKind = 'pr' | 'staged' | 'unstaged' | 'scope' | 'unknown';

export interface ReviewIndexEntry {
  workspaceId: string;
  revisionId: string;
  subject: string;
  sourceKind: ReviewIndexSourceKind;
  itemCount: number;
  reviewedCount: number;
  openQuestions: number;
  updatedAt: string;
  degraded?: string;
}

export interface ReviewIndexResponse {
  reviews: ReviewIndexEntry[];
}

export async function fetchReviewIndex(signal?: AbortSignal): Promise<ReviewIndexResponse> {
  const res = await fetch('/api/reviews', { signal });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GET /api/reviews failed (${res.status}): ${text}`);
  }
  return (await res.json()) as ReviewIndexResponse;
}
