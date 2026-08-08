import { performance } from 'node:perf_hooks';
import {
  type ProposedCodeSection,
  type ReviewBundle,
  type ReviewGroup,
  type ReviewInsights,
  type ReviewItemInsight,
  type ReviewProgress,
  type ReviewRef,
  type ReviewSnapshot,
  type ReviewSourceFreshness,
  type ReviewWorkspace,
  applyCodeSections,
  buildDiffSnapshot,
  buildScopeSnapshot,
  compareReviewSourceFreshness,
  createReviewStore,
  deriveReviewReadiness,
  formatReviewRef,
  hashText,
  isReviewCoreError,
  reconcileReview,
} from '@synergy/review-core';
import { previewStatus } from './preview.js';
import {
  type ReviewAnalysisGuidance,
  deriveReviewAnalysisGuidance,
} from './review-analysis-guidance.js';
import type { ReviewAnalysisInput, ScopeAnalysisSectionInput } from './review-analysis.js';
import {
  type CaptureReviewSourceRequest,
  type CapturedReviewSource,
  captureReviewSource,
  repositoryName,
  resolveRepositoryRoot,
} from './review-capture.js';
import { assertCompleteScopeCoverage } from './review-coverage.js';

export interface CreateReviewRequest extends CaptureReviewSourceRequest {}

export interface CreateReviewResult {
  reference: ReviewRef;
  resumed: boolean;
  url: string;
  analysisRequired: boolean;
  analysisGuidance?: ReviewAnalysisGuidance;
}

export interface ReviewActionDependencies {
  createStore?: typeof createReviewStore;
}

export interface ApplyReviewAnalysisDependencies {
  createStore?: typeof createReviewStore;
  applyCodeSections?: typeof applyCodeSections;
  previewStatus?: typeof previewStatus;
  now?: () => Date;
  monotonicNow?: () => number;
}

export interface OpenReviewDependencies {
  previewStatus?: typeof previewStatus;
}

export class PreviewNotReadyError extends Error {
  readonly code = 'preview_not_ready';
  readonly suggestedCommand: {
    command: 'synergy';
    args: ['preview', 'start', '--root', string];
  };

  constructor(readonly root: string) {
    const args: ['preview', 'start', '--root', string] = ['preview', 'start', '--root', root];
    super(
      `Preview is not ready for project root ${JSON.stringify(root)}. Invoke the Synergy executable with argv ${JSON.stringify(args)}.`,
    );
    this.suggestedCommand = {
      command: 'synergy',
      args,
    };
  }
}

export interface RefreshReviewRequest {
  root: string;
  workspaceId: string;
  runner?: CaptureReviewSourceRequest['runner'];
  readFile?: CaptureReviewSourceRequest['readFile'];
}

interface CanonicalReviewAnalysis {
  groups: ReviewGroup[];
  items: ReviewItemInsight[];
}

export interface ApplyReviewAnalysisRequest {
  root: string;
  reference: ReviewRef;
  analysis: ReviewAnalysisInput;
  parsingInMs?: number;
  commandStartedAt?: number;
}

export interface ReviewAnalysisTimings {
  parsingMs: number;
  derivationMs: number;
  validationMs: number;
  publicationMs: number;
  previewResolutionMs: number;
  totalMs: number;
}

export interface ReviewAnalysisSetResult {
  reference: string;
  analysisFinalized: true;
  reviewItemCount: number;
  groupCount: number;
  withinRecommendedRange: boolean;
  analysisFinalizedInMs: number;
  route: string;
  previewReady: boolean;
  url?: string;
  timings: ReviewAnalysisTimings;
}

export interface ReviewStatusRequest {
  root: string;
  reference: ReviewRef;
  runner?: CaptureReviewSourceRequest['runner'];
  readFile?: CaptureReviewSourceRequest['readFile'];
  compareSourceFreshness?: typeof compareReviewSourceFreshness;
}

export interface ReviewStatusResult {
  reference: string;
  analysisRequired: boolean;
  readiness: ReturnType<typeof deriveReviewReadiness>;
  captureFailed: boolean;
  url: string;
  analysisGuidance?: ReviewAnalysisGuidance;
}

const GROUP_ID = /^[a-z0-9][a-z0-9_-]*$/u;
const MAX_DESCRIPTION_LENGTH = 600;

function reviewUrl(reference: ReviewRef): string {
  return `/r/${encodeURIComponent(reference.workspaceId)}/${encodeURIComponent(reference.revisionId)}`;
}

function workspaceIdFor(root: string, captured: CapturedReviewSource): string {
  const repository = repositoryName(root);
  switch (captured.source.kind) {
    case 'pr':
      return `${repository}-pr-${captured.source.number}`;
    case 'staged':
      return `${repository}-staged`;
    case 'unstaged':
      return `${repository}-unstaged`;
    case 'scope':
      return `${repository}-scope-${hashText(captured.source.patterns.join('\0')).slice(0, 10)}`;
  }
}

function revisionIdFor(captured: CapturedReviewSource): string {
  return `rev-${captured.fingerprint.slice(0, 16)}`;
}

function initialProgress(snapshot: ReviewSnapshot, now: string): ReviewProgress {
  return {
    schemaVersion: 1,
    updatedAt: now,
    items: Object.fromEntries(snapshot.items.map((item) => [item.id, { status: 'needs-review' }])),
  };
}

/**
 * Reconciles progress for a new snapshot against its predecessor, discarding the carried file
 * insights that ride alongside the progress result. Wiring carried file descriptions into the
 * persisted `ReviewInsights` is not yet implemented here; the store's `ReviewProgress` schema
 * rejects unknown properties, so the extra `insights` field cannot be forwarded as-is.
 */
function reconcileProgress(
  previous: ReviewBundle,
  snapshot: ReviewSnapshot,
  now: string,
): ReviewProgress {
  const { insights: _carriedInsights, ...progress } = reconcileReview(previous, snapshot, now);
  return progress;
}

function buildSnapshot(
  captured: CapturedReviewSource,
  revisionId: string,
  now: string,
  predecessorRevisionId?: string,
): ReviewSnapshot {
  if (captured.source.kind === 'scope') {
    if (!captured.files) throw new Error('scope capture did not include eligible source files');
    return buildScopeSnapshot({
      revisionId,
      predecessorRevisionId,
      source: captured.source,
      fingerprint: captured.fingerprint,
      createdAt: now,
      files: captured.files,
    });
  }
  if (!captured.patch) throw new Error('diff capture did not include a patch');
  return buildDiffSnapshot({
    revisionId,
    predecessorRevisionId,
    source: captured.source,
    fingerprint: captured.fingerprint,
    createdAt: now,
    patch: captured.patch,
  });
}

function resultFor(root: string, reference: ReviewRef, resumed: boolean): CreateReviewResult {
  const store = createReviewStore(root);
  const bundle = store.readBundle(reference.workspaceId, reference.revisionId);
  return {
    reference,
    resumed,
    url: reviewUrl(reference),
    analysisRequired: !store.isAnalysisFinalized(reference.workspaceId, reference.revisionId),
    ...(bundle.snapshot.kind === 'scope'
      ? { analysisGuidance: deriveReviewAnalysisGuidance(bundle.snapshot) }
      : {}),
  };
}

function createWorkspace(
  root: string,
  workspaceId: string,
  revisionId: string,
  captured: CapturedReviewSource,
  existing: ReviewWorkspace | undefined,
  now: string,
): ReviewWorkspace {
  return {
    schemaVersion: 1,
    id: workspaceId,
    repository: { root, name: repositoryName(root) },
    source: captured.source,
    currentRevisionId: revisionId,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

export function createOrResumeReview(
  request: CreateReviewRequest,
  dependencies: ReviewActionDependencies = {},
): CreateReviewResult {
  const root = resolveRepositoryRoot(request.root, request.runner);
  const captured = captureReviewSource({ ...request, root });
  const store = (dependencies.createStore ?? createReviewStore)(root);
  const workspaceId = workspaceIdFor(root, captured);
  const existingRevision = store.findRevisionByFingerprint(workspaceId, captured.fingerprint);
  if (existingRevision) {
    store.setCurrentRevision(workspaceId, existingRevision, captured.source, {
      root,
      name: repositoryName(root),
    });
    return resultFor(root, { workspaceId, revisionId: existingRevision }, true);
  }

  const now = new Date().toISOString();
  const revisionId = revisionIdFor(captured);
  const existingWorkspace = store
    .listWorkspaces()
    .find((workspace) => workspace.id === workspaceId);
  const snapshot = buildSnapshot(captured, revisionId, now, existingWorkspace?.currentRevisionId);
  const workspace = createWorkspace(
    root,
    workspaceId,
    revisionId,
    captured,
    existingWorkspace,
    now,
  );
  const insights: ReviewInsights = { schemaVersion: 1, revisionId, groups: [], items: [] };
  const progress = existingWorkspace
    ? reconcileProgress(
        store.readBundle(workspaceId, existingWorkspace.currentRevisionId),
        snapshot,
        now,
      )
    : initialProgress(snapshot, now);
  try {
    store.createRevision(workspace, snapshot, insights, progress);
  } catch (error) {
    if (!isReviewCoreError(error) || error.code !== 'review_conflict') throw error;
    const concurrentRevision = store.findRevisionByFingerprint(workspaceId, captured.fingerprint);
    if (!concurrentRevision) throw error;
    store.setCurrentRevision(workspaceId, concurrentRevision, captured.source, {
      root,
      name: repositoryName(root),
    });
    return resultFor(root, { workspaceId, revisionId: concurrentRevision }, true);
  }
  return resultFor(root, { workspaceId, revisionId }, false);
}

function captureRequestFromWorkspace(
  workspace: ReviewWorkspace,
): CaptureReviewSourceRequest['source'] {
  switch (workspace.source.kind) {
    case 'pr':
      return { kind: 'pr', selector: workspace.source.url };
    case 'staged':
      return { kind: 'staged' };
    case 'unstaged':
      return { kind: 'unstaged' };
    case 'scope':
      return { kind: 'scope', patterns: workspace.source.patterns };
  }
}

export function refreshReview(request: RefreshReviewRequest): CreateReviewResult {
  const root = resolveRepositoryRoot(request.root, request.runner);
  const workspace = createReviewStore(root).readWorkspace(request.workspaceId);
  return createOrResumeReview({
    root,
    runner: request.runner,
    readFile: request.readFile,
    source: captureRequestFromWorkspace(workspace),
  });
}

function assertSafeEvidencePath(path: string): void {
  if (
    path.length === 0 ||
    path.includes('\0') ||
    path.startsWith('/') ||
    path.startsWith('\\') ||
    path.split(/[\\/]/u).some((segment) => segment === '.' || segment === '..')
  ) {
    throw new Error(`invalid evidence path: ${path}`);
  }
}

function assertValidAnalysis(snapshot: ReviewSnapshot, analysis: CanonicalReviewAnalysis): void {
  const itemIds = new Set(snapshot.items.map((item) => item.id));
  const groupIds = new Set<string>();
  const groupedItemIds = new Set<string>();
  for (const group of analysis.groups) {
    if (!GROUP_ID.test(group.id)) throw new Error(`invalid review group id: ${group.id}`);
    if (groupIds.has(group.id)) throw new Error(`duplicate review group id: ${group.id}`);
    if (group.label.trim().length === 0) throw new Error('review group label cannot be empty');
    if (group.reviewItemIds.length === 0)
      throw new Error(`review group ${group.id} has no review items`);
    groupIds.add(group.id);
    for (const reviewItemId of group.reviewItemIds) {
      if (!itemIds.has(reviewItemId)) throw new Error(`unknown review item: ${reviewItemId}`);
      if (groupedItemIds.has(reviewItemId)) {
        throw new Error(`review item appears in multiple groups: ${reviewItemId}`);
      }
      groupedItemIds.add(reviewItemId);
    }
  }

  const insightIds = new Set<string>();
  const confidenceValues = new Set(['high', 'medium', 'low']);
  const evidencePaths = new Set(
    snapshot.kind === 'diff'
      ? snapshot.files.map((file) => file.path)
      : snapshot.files.map((file) => file.path),
  );
  for (const insight of analysis.items) {
    if (!itemIds.has(insight.reviewItemId)) {
      throw new Error(`unknown review item: ${insight.reviewItemId}`);
    }
    if (insightIds.has(insight.reviewItemId)) {
      throw new Error(`duplicate review item analysis: ${insight.reviewItemId}`);
    }
    if (
      insight.description.trim().length === 0 ||
      Array.from(insight.description).length > MAX_DESCRIPTION_LENGTH
    ) {
      throw new Error(`review item description must be 1-${MAX_DESCRIPTION_LENGTH} characters`);
    }
    if (!confidenceValues.has(insight.confidence)) {
      throw new Error(`invalid review item confidence: ${insight.confidence}`);
    }
    for (const path of insight.evidencePaths) assertSafeEvidencePath(path);
    if (insight.evidencePaths.length === 0) {
      throw new Error(`review item analysis requires captured evidence: ${insight.reviewItemId}`);
    }
    if (new Set(insight.evidencePaths).size !== insight.evidencePaths.length) {
      throw new Error(`review item analysis has duplicate evidence paths: ${insight.reviewItemId}`);
    }
    for (const path of insight.evidencePaths) {
      if (!evidencePaths.has(path)) throw new Error(`evidence path was not captured: ${path}`);
    }
    insightIds.add(insight.reviewItemId);
  }

  for (const itemId of itemIds) {
    if (!groupedItemIds.has(itemId)) throw new Error(`review item is missing a group: ${itemId}`);
    if (!insightIds.has(itemId)) throw new Error(`review item is missing an analysis: ${itemId}`);
  }
}

function proposedCodeSection(section: ScopeAnalysisSectionInput): ProposedCodeSection {
  return {
    path: section.path,
    label: section.label,
    ...(section.parentLabel === undefined ? {} : { parentLabel: section.parentLabel }),
    start: section.start,
    end: section.end,
  };
}

function translateScopeAnalysis(
  snapshot: Extract<ReviewSnapshot, { kind: 'scope' }>,
  analysis: Extract<ReviewAnalysisInput, { kind: 'scope' }>,
  applySections: typeof applyCodeSections,
): { snapshot: Extract<ReviewSnapshot, { kind: 'scope' }>; analysis: CanonicalReviewAnalysis } {
  assertCompleteScopeCoverage(snapshot, analysis.sections);
  const translatedSnapshot = applySections(snapshot, analysis.sections.map(proposedCodeSection));
  if (translatedSnapshot.items.length !== analysis.sections.length) {
    throw new Error('scope section translation did not return one review item per section');
  }

  const itemIdBySectionKey = new Map(
    analysis.sections.map((section, index) => [section.key, translatedSnapshot.items[index]!.id]),
  );
  const groups = analysis.groups.map(
    (group): ReviewGroup => ({
      id: group.id,
      label: group.label,
      reviewItemIds: group.sectionKeys.map((sectionKey) => {
        const reviewItemId = itemIdBySectionKey.get(sectionKey);
        if (!reviewItemId) throw new Error(`unknown scope section key: ${sectionKey}`);
        return reviewItemId;
      }),
    }),
  );
  const items = analysis.sections.map(
    (section, index): ReviewItemInsight => ({
      reviewItemId: translatedSnapshot.items[index]!.id,
      description: section.description,
      confidence: section.confidence,
      evidencePaths: section.evidencePaths,
    }),
  );
  return { snapshot: translatedSnapshot, analysis: { groups, items } };
}

export async function applyReviewAnalysis(
  request: ApplyReviewAnalysisRequest,
  dependencies: ApplyReviewAnalysisDependencies = {},
): Promise<ReviewAnalysisSetResult> {
  const monotonicNow = dependencies.monotonicNow ?? (() => performance.now());
  const actionStartedAt = readMonotonic(monotonicNow);
  const parsingMs = assertNonnegativeDuration(request.parsingInMs ?? 0, 'analysis parsing');
  const store = (dependencies.createStore ?? createReviewStore)(request.root);
  const bundle = store.readBundle(request.reference.workspaceId, request.reference.revisionId);
  if (store.isAnalysisFinalized(request.reference.workspaceId, request.reference.revisionId)) {
    throw new Error('review analysis already exists and is immutable');
  }
  const now = dependencies.now ?? (() => new Date());
  let reviewItemCount: number;
  let groupCount: number;
  let withinRecommendedRange: boolean;
  let finalizedAt: string;
  let derivationMs = 0;
  let validationMs = 0;
  let publicationMs = 0;
  if (bundle.snapshot.kind === 'scope') {
    if (request.analysis.kind !== 'scope') {
      throw new Error('scoped review requires a scope analysis payload');
    }
    const scopeSnapshot = bundle.snapshot;
    const scopeAnalysis = request.analysis;
    const translation = measureMonotonic(monotonicNow, () =>
      translateScopeAnalysis(
        scopeSnapshot,
        scopeAnalysis,
        dependencies.applyCodeSections ?? applyCodeSections,
      ),
    );
    const translated = translation.value;
    derivationMs += translation.durationMs;
    validationMs += measureMonotonic(monotonicNow, () => {
      assertValidAnalysis(translated.snapshot, translated.analysis);
    }).durationMs;
    const insights: ReviewInsights = {
      schemaVersion: 1,
      revisionId: request.reference.revisionId,
      groups: translated.analysis.groups,
      items: translated.analysis.items,
    };
    const derived = measureMonotonic(monotonicNow, () => {
      const progressTimestamp = nondecreasingIsoTimestamp(bundle.snapshot.createdAt, now());
      const progress = bundle.snapshot.predecessorRevisionId
        ? reconcileProgress(
            store.readBundle(request.reference.workspaceId, bundle.snapshot.predecessorRevisionId),
            translated.snapshot,
            progressTimestamp,
          )
        : initialProgress(translated.snapshot, progressTimestamp);
      const guidance = deriveReviewAnalysisGuidance(bundle.snapshot);
      return { progress, guidance, progressTimestamp };
    });
    derivationMs += derived.durationMs;
    finalizedAt = nondecreasingIsoTimestamp(derived.value.progressTimestamp, now());
    publicationMs += measureMonotonic(monotonicNow, () => {
      store.finalizeScopeAnalysis(
        request.reference.workspaceId,
        request.reference.revisionId,
        translated.snapshot,
        insights,
        derived.value.progress,
        finalizedAt,
      );
    }).durationMs;
    reviewItemCount = translated.snapshot.items.length;
    groupCount = translated.analysis.groups.length;
    withinRecommendedRange =
      reviewItemCount >= derived.value.guidance.minimumSections &&
      reviewItemCount <= derived.value.guidance.maximumSections;
  } else {
    if (request.analysis.kind !== 'diff') {
      throw new Error('diff review requires a diff analysis payload');
    }
    const diffAnalysis = request.analysis;
    validationMs += measureMonotonic(monotonicNow, () => {
      assertValidAnalysis(bundle.snapshot, diffAnalysis);
    }).durationMs;
    const insights: ReviewInsights = {
      schemaVersion: 1,
      revisionId: request.reference.revisionId,
      groups: diffAnalysis.groups,
      items: diffAnalysis.items,
    };
    finalizedAt = nondecreasingIsoTimestamp(bundle.snapshot.createdAt, now());
    publicationMs += measureMonotonic(monotonicNow, () => {
      store.writeInitialInsights(
        request.reference.workspaceId,
        request.reference.revisionId,
        insights,
        finalizedAt,
      );
    }).durationMs;
    reviewItemCount = bundle.snapshot.items.length;
    groupCount = diffAnalysis.groups.length;
    // Diff item boundaries are captured canonically rather than agent-sized, so this range is
    // satisfied by construction. Scope reviews use the explicit section guidance above.
    withinRecommendedRange = true;
  }
  const persistedFinalizedAt = store.getAnalysisFinalizedAt(
    request.reference.workspaceId,
    request.reference.revisionId,
  );
  if (persistedFinalizedAt !== finalizedAt) {
    throw new Error('review analysis finalization milestone was not persisted');
  }
  const analysisFinalizedInMs = assertFinalizationInterval(
    bundle.snapshot.createdAt,
    persistedFinalizedAt,
  );

  const route = reviewUrl(request.reference);
  const baseResult = {
    reference: formatReviewRef(request.reference.workspaceId, request.reference.revisionId),
    analysisFinalized: true as const,
    reviewItemCount,
    groupCount,
    withinRecommendedRange,
    analysisFinalizedInMs,
    route,
  };
  let previewReady = false;
  let url: string | undefined;
  const previewStartedAt = readMonotonic(monotonicNow);
  try {
    const status = await (dependencies.previewStatus ?? previewStatus)(request.root);
    if (status.running && status.origin !== null) {
      url = new URL(route, status.origin).toString();
      previewReady = true;
    }
  } catch {
    // Preview readiness is advisory and never changes successful durable finalization.
  }
  const previewResolutionMs = elapsedMonotonic(monotonicNow, previewStartedAt);
  const totalEndedAt = readMonotonic(monotonicNow);
  const actionTotalMs = assertNonnegativeDuration(totalEndedAt - actionStartedAt, 'analysis total');
  const totalMs =
    request.commandStartedAt === undefined
      ? assertNonnegativeDuration(parsingMs + actionTotalMs, 'analysis total')
      : assertNonnegativeDuration(totalEndedAt - request.commandStartedAt, 'analysis total');
  return {
    ...baseResult,
    previewReady,
    ...(url === undefined ? {} : { url }),
    timings: {
      parsingMs,
      derivationMs,
      validationMs,
      publicationMs,
      previewResolutionMs,
      totalMs,
    },
  };
}

function assertFinalizationInterval(capturedAt: string, finalizedAt: string): number {
  const duration = Date.parse(finalizedAt) - Date.parse(capturedAt);
  if (!Number.isFinite(duration) || duration < 0) {
    throw new Error('review analysis finalization cannot precede the captured snapshot');
  }
  return duration;
}

function nondecreasingIsoTimestamp(minimum: string, candidate: Date): string {
  const minimumMs = Date.parse(minimum);
  const candidateMs = candidate.getTime();
  if (!Number.isFinite(minimumMs) || !Number.isFinite(candidateMs)) {
    throw new Error('review analysis finalization timestamps must be valid');
  }
  return new Date(Math.max(minimumMs, candidateMs)).toISOString();
}

function assertNonnegativeDuration(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0)
    throw new Error(`${label} duration must be nonnegative`);
  return value;
}

function readMonotonic(clock: () => number): number {
  const value = clock();
  if (!Number.isFinite(value)) throw new Error('analysis monotonic clock must be finite');
  return value;
}

function elapsedMonotonic(clock: () => number, startedAt: number): number {
  return assertNonnegativeDuration(readMonotonic(clock) - startedAt, 'analysis phase');
}

function measureMonotonic<T>(
  clock: () => number,
  operation: () => T,
): { value: T; durationMs: number } {
  const startedAt = readMonotonic(clock);
  const value = operation();
  return { value, durationMs: elapsedMonotonic(clock, startedAt) };
}

export function listReviews(root: string): ReviewWorkspace[] {
  return createReviewStore(root).listWorkspaces();
}

export async function openReview(
  root: string,
  reference: ReviewRef,
  dependencies: OpenReviewDependencies = {},
): Promise<string> {
  createReviewStore(root).readBundle(reference.workspaceId, reference.revisionId);
  const status = await (dependencies.previewStatus ?? previewStatus)(root);
  if (!status.running || status.origin === null) throw new PreviewNotReadyError(root);
  return new URL(reviewUrl(reference), status.origin).toString();
}

export function getReviewStatus(request: ReviewStatusRequest): ReviewStatusResult {
  const root = resolveRepositoryRoot(request.root, request.runner);
  const store = createReviewStore(root);
  // Finalization publishes the durable marker after atomically replacing the scoped bundle.
  // Reading the marker first avoids reporting a pending bundle as finalized during that handoff.
  const analysisFinalized = store.isAnalysisFinalized(
    request.reference.workspaceId,
    request.reference.revisionId,
  );
  const bundle = store.readBundle(request.reference.workspaceId, request.reference.revisionId);
  const compare = request.compareSourceFreshness ?? compareReviewSourceFreshness;
  const freshness: ReviewSourceFreshness = compare(bundle.snapshot, root, {
    runner: request.runner,
    readFile: request.readFile,
  });
  const readiness = deriveReviewReadiness(
    {
      ...bundle,
      sourceChanged: freshness.sourceChanged,
    },
    analysisFinalized,
  );
  return {
    reference: formatReviewRef(request.reference.workspaceId, request.reference.revisionId),
    analysisRequired: !analysisFinalized,
    readiness,
    captureFailed: freshness.captureFailed,
    url: reviewUrl(request.reference),
    ...(bundle.snapshot.kind === 'scope'
      ? { analysisGuidance: deriveReviewAnalysisGuidance(bundle.snapshot) }
      : {}),
  };
}

export function formatReviewStatusJson(request: ReviewStatusRequest): string {
  return JSON.stringify(getReviewStatus(request), null, 2);
}

export function printReviewStatus(request: ReviewStatusRequest): string {
  const status = getReviewStatus(request);
  const state = status.analysisRequired
    ? 'analysis required'
    : status.readiness.ready
      ? 'ready'
      : 'needs review';
  const sourceState = status.captureFailed
    ? 'capture failed'
    : status.readiness.sourceChanged
      ? 'changed'
      : 'unchanged';
  return [
    status.reference,
    state,
    `source: ${sourceState}`,
    `pending: ${status.readiness.pending}`,
    `stale: ${status.readiness.stale}`,
    `unanswered: ${status.readiness.unanswered}`,
    `url: ${status.url}`,
  ].join('\n');
}
