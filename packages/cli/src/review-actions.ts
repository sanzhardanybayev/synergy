import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  type AnalysisPolicy,
  type ProposedCodeSection,
  type RemovalRationale,
  type ReviewBundle,
  type ReviewFileInsight,
  type ReviewGroup,
  type ReviewInsights,
  type ReviewItemInsight,
  type ReviewProgress,
  type ReviewRef,
  type ReviewSnapshot,
  type ReviewSource,
  type ReviewSourceFreshness,
  type ReviewWorkspace,
  applyCodeSections,
  buildDiffSnapshot,
  buildScopeSnapshot,
  compareReviewSourceFreshness,
  createReviewStore,
  deriveReviewReadiness,
  deriveSnapshotRemovalRuns,
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
import {
  MAX_INTRO_LENGTH,
  MAX_SUMMARY_LENGTH,
  type ReviewAnalysisInput,
  type ScopeAnalysisSectionInput,
} from './review-analysis.js';
import {
  type CaptureReviewSourceRequest,
  type CapturedReviewSource,
  type CommandRunner,
  captureReviewSource,
  repositoryName,
  resolveRepositoryRoot,
  systemCommandRunner,
} from './review-capture.js';
import { assertCompleteScopeCoverage } from './review-coverage.js';
import {
  type RemovalExcerptIo,
  assertCompleteRemovalCoverage,
  assertSafeEvidencePath,
  reResolveCarriedRemovals,
  resolveRemovalExcerpts,
} from './review-removals.js';

export interface CreateReviewRequest extends CaptureReviewSourceRequest {
  /** Reviewer's removal-rationale coverage policy for this call, from `--explain-removals`.
   * Omit to leave the workspace's stored policy untouched (this is how `refreshReview` reuses
   * it). A brand-new workspace with no explicit value defaults to off. Re-running `create` with
   * an explicit value on an EXISTING workspace updates the stored policy, unless the current
   * revision's analysis is already finalized (immutable) - see `analysisPolicyLocked` below. */
  explainRemovals?: boolean;
}

export interface CreateReviewResult {
  reference: ReviewRef;
  resumed: boolean;
  url: string;
  analysisRequired: boolean;
  analysisGuidance?: ReviewAnalysisGuidance;
  removals: ReviewRemovalStatus[];
  /** The workspace's current removal-rationale coverage policy after this call. */
  analysisPolicy: AnalysisPolicy;
  /** True when this call asked to change `explainRemovals` but the target revision's analysis
   * is already finalized, so the immutable revision was left exactly as-is instead of silently
   * dropping the request. */
  analysisPolicyLocked?: boolean;
  /** Repository-relative exclude patterns active for this review's source, normalized and
   * sorted. Absent when no excludes are configured. */
  excludes?: string[];
  /** Number of files this capture dropped because they matched an exclude pattern. Only
   * present when excludes are configured. */
  excludedFileCount?: number;
}

export interface ReviewActionDependencies {
  createStore?: typeof createReviewStore;
  /** Reads a movedTo target's destination lines when re-resolving carried removal excerpts
   * against the new revision's live worktree (unstaged/scope sources only - staged/PR sources
   * read immutable Git content through `request.runner` instead). Defaults to real filesystem
   * reads. */
  readFile?: ReadFile;
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
  removals?: RemovalRationale[];
  summary?: string;
}

/** Reads a repository-relative path's full text, or undefined when it does not exist at the
 * inspected source (a missing file is a normal outcome here, not an error). */
export type ReadFile = (path: string) => string | undefined;

export interface ApplyReviewAnalysisRequest {
  root: string;
  reference: ReviewRef;
  analysis: ReviewAnalysisInput;
  parsingInMs?: number;
  commandStartedAt?: number;
  runner?: CommandRunner;
  readFile?: ReadFile;
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

export interface ReviewRemovalStatus {
  reviewItemId: string;
  path: string;
  start: number;
  end: number;
  /** Whether the currently persisted insights already carry a rationale for this exact run. */
  covered: boolean;
}

export interface ReviewStatusResult {
  reference: string;
  analysisRequired: boolean;
  readiness: ReturnType<typeof deriveReviewReadiness>;
  captureFailed: boolean;
  url: string;
  analysisGuidance?: ReviewAnalysisGuidance;
  removals: ReviewRemovalStatus[];
  /** Repository-relative exclude patterns active for this review's source, normalized and
   * sorted. Absent when no excludes are configured. */
  excludes?: string[];
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
 * Reconciles progress for a new snapshot against its predecessor. The carried file and removal
 * insights that ride alongside the progress result are returned separately so callers can fold
 * them into the new revision's `ReviewInsights` document (the store's `ReviewProgress` schema
 * rejects unknown properties, so they cannot be forwarded as part of the progress object itself).
 */
function reconcileProgressAndInsights(
  previous: ReviewBundle,
  snapshot: ReviewSnapshot,
  now: string,
): {
  progress: ReviewProgress;
  files: ReviewFileInsight[] | undefined;
  removals: RemovalRationale[] | undefined;
} {
  const { insights, ...progress } = reconcileReview(previous, snapshot, now);
  return { progress, files: insights.files, removals: insights.removals };
}

/** Every derived removal run for a bundle's snapshot, flagged with whether its persisted
 * insights already carry a rationale for that exact run - the authoring agent's checklist of
 * what it still has to explain. Matches `mergeRemovalInsights`'s run-only key (no
 * `reviewItemId`) deliberately: a rationale can only be persisted for a run it actually names
 * (`assertCompleteRemovalCoverage` rejects a mismatched `reviewItemId` independently), so the
 * ownership check does not need to be repeated here for correctness. */
function removalsStatusFor(bundle: ReviewBundle): ReviewRemovalStatus[] {
  const coveredRunKeys = new Set(
    (bundle.insights.removals ?? []).map((rationale) =>
      removalRunKey(rationale.run.path, rationale.run.start, rationale.run.end),
    ),
  );
  return deriveSnapshotRemovalRuns(bundle.snapshot).map((run) => ({
    reviewItemId: run.reviewItemId,
    path: run.path,
    start: run.start,
    end: run.end,
    covered: coveredRunKeys.has(removalRunKey(run.path, run.start, run.end)),
  }));
}

/**
 * Merges fresh per-file analysis with carried-forward file insights from the predecessor
 * revision. Fresh entries win for the paths they cover; carried entries survive for paths the
 * fresh analysis omits (typically files whose review items were all carried forward untouched).
 */
function mergeFileInsights(
  carried: ReviewFileInsight[] | undefined,
  fresh: ReviewFileInsight[] | undefined,
): ReviewFileInsight[] | undefined {
  if (!fresh || fresh.length === 0) return carried;
  if (!carried || carried.length === 0) return fresh;
  const freshPaths = new Set(fresh.map((file) => file.path));
  const survivingCarried = carried.filter((file) => !freshPaths.has(file.path));
  return [...fresh, ...survivingCarried];
}

function removalRunKey(path: string, start: number, end: number): string {
  return `${path}:${start}-${end}`;
}

/**
 * Merges freshly submitted removal rationales with the predecessor's carried-forward ones, keyed
 * by run (`path:start-end`) rather than path: fresh entries win for the runs they cover, carried
 * entries survive for runs the fresh payload omits. This is what makes `covered: true` in
 * `removalsStatusFor` an accurate prediction of finalize-time acceptance - an agent that sees a
 * carried run reported as covered may omit it from its submission and have it still count toward
 * `assertCompleteRemovalCoverage`, exactly like `mergeFileInsights` does for file insights.
 */
function mergeRemovalInsights(
  carried: RemovalRationale[] | undefined,
  fresh: RemovalRationale[] | undefined,
): RemovalRationale[] | undefined {
  if (!fresh || fresh.length === 0) return carried;
  if (!carried || carried.length === 0) return fresh;
  const freshKeys = new Set(
    fresh.map((rationale) =>
      removalRunKey(rationale.run.path, rationale.run.start, rationale.run.end),
    ),
  );
  const survivingCarried = carried.filter(
    (rationale) =>
      !freshKeys.has(removalRunKey(rationale.run.path, rationale.run.start, rationale.run.end)),
  );
  return [...fresh, ...survivingCarried];
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

function resultFor(
  root: string,
  reference: ReviewRef,
  resumed: boolean,
  captured?: CapturedReviewSource,
  analysisPolicyLocked?: boolean,
): CreateReviewResult {
  const store = createReviewStore(root);
  const bundle = store.readBundle(reference.workspaceId, reference.revisionId);
  const excludes = bundle.snapshot.source.excludes;
  return {
    reference,
    resumed,
    url: reviewUrl(reference),
    analysisRequired: !store.isAnalysisFinalized(reference.workspaceId, reference.revisionId),
    removals: removalsStatusFor(bundle),
    analysisPolicy: bundle.workspace.analysisPolicy ?? { explainRemovals: false },
    ...(analysisPolicyLocked ? { analysisPolicyLocked: true } : {}),
    ...(excludes && excludes.length > 0 ? { excludes } : {}),
    ...(captured?.excludedFileCount !== undefined
      ? { excludedFileCount: captured.excludedFileCount }
      : {}),
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
  explainRemovals: boolean | undefined,
): ReviewWorkspace {
  return {
    schemaVersion: 1,
    id: workspaceId,
    repository: { root, name: repositoryName(root) },
    source: captured.source,
    currentRevisionId: revisionId,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    analysisPolicy: {
      explainRemovals: explainRemovals ?? existing?.analysisPolicy?.explainRemovals ?? false,
    },
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
    // Re-running `create` on an identical diff is the escape hatch for a reviewer who wants to
    // change their mind about `--explain-removals` without recapturing: it must update the
    // stored policy here, not just resume the revision. The one case that must NOT rewrite it is
    // an already-finalized revision - that analysis is immutable, so the request is honored by
    // reporting `analysisPolicyLocked` rather than silently dropping it OR silently mutating a
    // published result.
    const finalized = store.isAnalysisFinalized(workspaceId, existingRevision);
    const requestedPolicy = request.explainRemovals;
    // The workspace pointer can be missing here (a crash between publishing the revision
    // directory and publishing `workspace.json` - see `createRevision`'s orphan-recovery path),
    // in which case there is no prior policy to compare against; treat it the same as "off",
    // mirroring `setCurrentRevision`'s own fallback for a missing workspace file.
    let priorExplainRemovals = false;
    try {
      priorExplainRemovals =
        store.readWorkspace(workspaceId).analysisPolicy?.explainRemovals ?? false;
    } catch (error) {
      if (!isReviewCoreError(error) || error.code !== 'review_not_found') throw error;
    }
    const policyChangeRequested =
      requestedPolicy !== undefined && requestedPolicy !== priorExplainRemovals;
    const applyPolicy = policyChangeRequested && !finalized;
    store.setCurrentRevision(
      workspaceId,
      existingRevision,
      captured.source,
      { root, name: repositoryName(root) },
      applyPolicy ? { explainRemovals: requestedPolicy as boolean } : undefined,
    );
    return resultFor(
      root,
      { workspaceId, revisionId: existingRevision },
      true,
      captured,
      policyChangeRequested && finalized,
    );
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
    request.explainRemovals,
  );
  const reconciliation = existingWorkspace
    ? reconcileProgressAndInsights(
        store.readBundle(workspaceId, existingWorkspace.currentRevisionId),
        snapshot,
        now,
      )
    : undefined;
  const progress = reconciliation?.progress ?? initialProgress(snapshot, now);
  // Carried removal rationales are re-resolved against THIS revision's own source here, at
  // creation time - not deferred to finalize - so `status.removals[].covered` stays honest: a
  // rationale that survives is one whose moved-to destination was just verified against the
  // source `review refresh` just captured, not against a stale predecessor read.
  const carriedRemovals =
    reconciliation?.removals && reconciliation.removals.length > 0
      ? reResolveCarriedRemovals(
          snapshot,
          reconciliation.removals,
          removalExcerptIo(
            root,
            captured.source,
            request.runner ?? systemCommandRunner,
            dependencies.readFile ?? defaultReadFile,
          ),
        )
      : undefined;
  const insights: ReviewInsights = {
    schemaVersion: 1,
    revisionId,
    groups: [],
    items: [],
    ...(reconciliation?.files ? { files: reconciliation.files } : {}),
    ...(carriedRemovals && carriedRemovals.length > 0 ? { removals: carriedRemovals } : {}),
  };
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
    return resultFor(root, { workspaceId, revisionId: concurrentRevision }, true, captured);
  }
  return resultFor(root, { workspaceId, revisionId }, false, captured);
}

function captureRequestFromWorkspace(
  workspace: ReviewWorkspace,
): CaptureReviewSourceRequest['source'] {
  const excludes = workspace.source.excludes;
  switch (workspace.source.kind) {
    case 'pr':
      return { kind: 'pr', selector: workspace.source.url, ...(excludes ? { excludes } : {}) };
    case 'staged':
      return { kind: 'staged', ...(excludes ? { excludes } : {}) };
    case 'unstaged':
      return { kind: 'unstaged', ...(excludes ? { excludes } : {}) };
    case 'scope':
      return {
        kind: 'scope',
        patterns: workspace.source.patterns,
        ...(excludes ? { excludes } : {}),
      };
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
    // Refresh reuses the stored policy verbatim (like `--exclude`) - it is not a `create`
    // re-run, so it must never change `explainRemovals` even implicitly.
    explainRemovals: workspace.analysisPolicy?.explainRemovals ?? false,
  });
}

function assertNarrativeText(value: string, max: number, label: string): void {
  if (value.trim().length === 0 || Array.from(value).length > max) {
    throw new Error(`${label} must be 1-${max} characters`);
  }
}

function assertValidAnalysis(
  snapshot: ReviewSnapshot,
  analysis: CanonicalReviewAnalysis,
  analysisPolicy: AnalysisPolicy | undefined,
): void {
  if (analysis.summary !== undefined) {
    assertNarrativeText(analysis.summary, MAX_SUMMARY_LENGTH, 'review summary');
  }
  for (const group of analysis.groups) {
    if (group.intro !== undefined) {
      assertNarrativeText(group.intro, MAX_INTRO_LENGTH, `group intro: ${group.id}`);
    }
  }
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

  // Scope snapshots derive zero removal runs, so the coverage requirement is a no-op there
  // regardless of policy; calling this unconditionally avoids threading the diff/scope
  // distinction back through this shared validator. Rationales that ARE submitted are always
  // validated for shape/correctness - only the "every run needs one" requirement is opt-in,
  // gated by the workspace's stored `analysisPolicy.explainRemovals`.
  assertCompleteRemovalCoverage(snapshot, analysis.removals ?? [], {
    requireCoverage: analysisPolicy?.explainRemovals === true,
  });
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
      ...(group.intro === undefined ? {} : { intro: group.intro }),
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
  return {
    snapshot: translatedSnapshot,
    analysis: {
      groups,
      items,
      ...(analysis.summary === undefined ? {} : { summary: analysis.summary }),
    },
  };
}

/** Splits file text into lines without letting a trailing newline manufacture a phantom final
 * line: "a\nb\n" is 2 lines, not 3, matching how line numbers are counted elsewhere in review
 * captures. A single trailing empty element (the artifact of `String.split` on a
 * newline-terminated string) is dropped; a genuine trailing blank line still survives because
 * only the file's own terminating newline produces that artifact. */
function splitLines(text: string): string[] {
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function defaultReadFile(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Runs `git -C <root> <args>`, collapsing a non-zero exit into undefined rather than throwing -
 * a missing path at a historical revision (e.g. `git show <sha>:<path>`) is a normal outcome. */
function runOptional(runner: CommandRunner, root: string, args: string[]): string | undefined {
  const result = runner.run('git', args, { cwd: root });
  if (result.exitCode !== 0) return undefined;
  return typeof result.stdout === 'string' ? result.stdout : result.stdout.toString('utf8');
}

/**
 * Builds the `movedTo` target reader for the review's captured source, mirroring how each
 * source kind must be inspected: a PR or staged capture reads immutable Git content (the head
 * commit or the index) so the target is stable even if the worktree later changes; unstaged and
 * scope captures have no such immutable pointer, so they read the live worktree file.
 */
function removalExcerptIo(
  root: string,
  source: ReviewSource,
  runner: CommandRunner,
  readFile: ReadFile,
): RemovalExcerptIo {
  return {
    readTargetLines(path) {
      const spec =
        source.kind === 'pr'
          ? `${source.headSha}:${path}`
          : source.kind === 'staged'
            ? `:${path}`
            : undefined;
      const text =
        spec === undefined ? readFile(join(root, path)) : runOptional(runner, root, ['show', spec]);
      return text === undefined ? undefined : splitLines(text);
    },
  };
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
      assertValidAnalysis(
        translated.snapshot,
        translated.analysis,
        bundle.workspace.analysisPolicy,
      );
    }).durationMs;
    const derived = measureMonotonic(monotonicNow, () => {
      const progressTimestamp = nondecreasingIsoTimestamp(bundle.snapshot.createdAt, now());
      const guidance = deriveReviewAnalysisGuidance(bundle.snapshot);
      if (!bundle.snapshot.predecessorRevisionId) {
        return {
          progress: initialProgress(translated.snapshot, progressTimestamp),
          carriedFiles: undefined as ReviewFileInsight[] | undefined,
          guidance,
          progressTimestamp,
        };
      }
      const reconciled = reconcileProgressAndInsights(
        store.readBundle(request.reference.workspaceId, bundle.snapshot.predecessorRevisionId),
        translated.snapshot,
        progressTimestamp,
      );
      return {
        progress: reconciled.progress,
        carriedFiles: reconciled.files,
        guidance,
        progressTimestamp,
      };
    });
    derivationMs += derived.durationMs;
    const scopeFiles = mergeFileInsights(derived.value.carriedFiles, scopeAnalysis.files);
    const insights: ReviewInsights = {
      schemaVersion: 1,
      revisionId: request.reference.revisionId,
      ...(translated.analysis.summary === undefined
        ? {}
        : { summary: translated.analysis.summary }),
      groups: translated.analysis.groups,
      items: translated.analysis.items,
      ...(scopeFiles ? { files: scopeFiles } : {}),
    };
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
    // A carried-forward rationale (seeded onto this revision's bundle at creation time, see
    // `createOrResumeReview`) is validated against the merged set below so an agent that reads
    // `status.removals[].covered === true` for it and omits it from this submission is still
    // accepted - `covered` must predict finalize-time acceptance, mirroring how `diffFiles`
    // below merges carried file insights with fresh ones.
    const carriedRemovals = bundle.insights.removals;
    // Excerpt resolution is folded into the validation measurement (not a separate bucket):
    // reading a movedTo target's destination lines is itself a rejection gate - an unreadable
    // file or an out-of-range span fails the payload exactly like assertValidAnalysis does - so
    // its cost belongs to the same "is this payload acceptable" timing as the rest of validation.
    // Excerpts are re-resolved only for the freshly submitted rationales: a carried rationale's
    // `movedToExcerpt` was already re-verified against THIS revision's own source at creation
    // time (`createOrResumeReview` -> `reResolveCarriedRemovals`), not merely carried untouched
    // from the predecessor - a stale destination is dropped there, before it ever reaches this
    // bundle, so `bundle.insights.removals` only ever contains carried rationales whose moved-to
    // excerpt (if any) is already honest for this exact revision. That earned trust is what lets
    // finalize skip re-reading it here.
    let resolvedRemovals: RemovalRationale[] | undefined;
    validationMs += measureMonotonic(monotonicNow, () => {
      assertValidAnalysis(
        bundle.snapshot,
        {
          ...diffAnalysis,
          removals: mergeRemovalInsights(carriedRemovals, diffAnalysis.removals) ?? [],
        },
        bundle.workspace.analysisPolicy,
      );
      const freshRemovals = diffAnalysis.removals
        ? resolveRemovalExcerpts(
            bundle.snapshot,
            diffAnalysis.removals,
            removalExcerptIo(
              request.root,
              bundle.snapshot.source,
              request.runner ?? systemCommandRunner,
              request.readFile ?? defaultReadFile,
            ),
          )
        : undefined;
      resolvedRemovals = mergeRemovalInsights(carriedRemovals, freshRemovals);
    }).durationMs;
    const diffFiles = mergeFileInsights(bundle.insights.files, diffAnalysis.files);
    const insights: ReviewInsights = {
      schemaVersion: 1,
      revisionId: request.reference.revisionId,
      ...(diffAnalysis.summary === undefined ? {} : { summary: diffAnalysis.summary }),
      groups: diffAnalysis.groups,
      items: diffAnalysis.items,
      ...(resolvedRemovals ? { removals: resolvedRemovals } : {}),
      ...(diffFiles ? { files: diffFiles } : {}),
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
  const excludes = bundle.snapshot.source.excludes;
  return {
    reference: formatReviewRef(request.reference.workspaceId, request.reference.revisionId),
    analysisRequired: !analysisFinalized,
    readiness,
    captureFailed: freshness.captureFailed,
    url: reviewUrl(request.reference),
    removals: removalsStatusFor(bundle),
    ...(excludes && excludes.length > 0 ? { excludes } : {}),
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
  const coveredRemovals = status.removals.filter((removal) => removal.covered).length;
  return [
    status.reference,
    state,
    `source: ${sourceState}`,
    `pending: ${status.readiness.pending}`,
    `stale: ${status.readiness.stale}`,
    `unanswered: ${status.readiness.unanswered}`,
    `removals: ${coveredRemovals}/${status.removals.length} explained`,
    ...(status.excludes && status.excludes.length > 0
      ? [`excludes: ${status.excludes.join(', ')}`]
      : []),
    `url: ${status.url}`,
  ].join('\n');
}
