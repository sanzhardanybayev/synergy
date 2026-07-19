import {
  type ProposedCodeSection,
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
import {
  type CaptureReviewSourceRequest,
  type CapturedReviewSource,
  captureReviewSource,
  repositoryName,
  resolveRepositoryRoot,
} from './review-capture.js';

export interface CreateReviewRequest extends CaptureReviewSourceRequest {}

export interface CreateReviewResult {
  reference: ReviewRef;
  resumed: boolean;
  url: string;
  analysisRequired: boolean;
}

export interface ReviewActionDependencies {
  createStore?: typeof createReviewStore;
}

export interface RefreshReviewRequest {
  root: string;
  workspaceId: string;
  runner?: CaptureReviewSourceRequest['runner'];
  readFile?: CaptureReviewSourceRequest['readFile'];
}

export interface ReviewAnalysis {
  groups: ReviewGroup[];
  items: ReviewItemInsight[];
  sections?: ProposedCodeSection[];
}

export interface ApplyReviewAnalysisRequest {
  root: string;
  reference: ReviewRef;
  analysis: ReviewAnalysis;
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
  store.readBundle(reference.workspaceId, reference.revisionId);
  return {
    reference,
    resumed,
    url: reviewUrl(reference),
    analysisRequired: !store.isAnalysisFinalized(reference.workspaceId, reference.revisionId),
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
    ? reconcileReview(
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

function assertValidAnalysis(snapshot: ReviewSnapshot, analysis: ReviewAnalysis): void {
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
      insight.description.length > MAX_DESCRIPTION_LENGTH
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

export function applyReviewAnalysis(request: ApplyReviewAnalysisRequest): ReviewRef {
  const store = createReviewStore(request.root);
  const bundle = store.readBundle(request.reference.workspaceId, request.reference.revisionId);
  if (store.isAnalysisFinalized(request.reference.workspaceId, request.reference.revisionId)) {
    throw new Error('review analysis already exists and is immutable');
  }
  const insights: ReviewInsights = {
    schemaVersion: 1,
    revisionId: request.reference.revisionId,
    groups: request.analysis.groups,
    items: request.analysis.items,
  };
  if (bundle.snapshot.kind === 'scope') {
    if (!request.analysis.sections)
      throw new Error('scoped review analysis requires proposed code sections');
    if (request.analysis.sections.length === 0) {
      throw new Error('scoped review analysis requires at least one code section');
    }
    const snapshot = applyCodeSections(bundle.snapshot, request.analysis.sections);
    assertValidAnalysis(snapshot, request.analysis);
    const now = new Date().toISOString();
    const progress = bundle.snapshot.predecessorRevisionId
      ? reconcileReview(
          store.readBundle(request.reference.workspaceId, bundle.snapshot.predecessorRevisionId),
          snapshot,
          now,
        )
      : initialProgress(snapshot, now);
    store.finalizeScopeAnalysis(
      request.reference.workspaceId,
      request.reference.revisionId,
      snapshot,
      insights,
      progress,
    );
  } else {
    if (request.analysis.sections)
      throw new Error('diff review analysis cannot define code sections');
    assertValidAnalysis(bundle.snapshot, request.analysis);
    store.writeInitialInsights(
      request.reference.workspaceId,
      request.reference.revisionId,
      insights,
    );
  }
  return request.reference;
}

export function listReviews(root: string): ReviewWorkspace[] {
  return createReviewStore(root).listWorkspaces();
}

export function openReview(root: string, reference: ReviewRef): string {
  createReviewStore(root).readBundle(reference.workspaceId, reference.revisionId);
  return reviewUrl(reference);
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
