import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { atomicWriteJson } from './atomic.js';
import { createFileReviewItem } from './diff.js';
import { ReviewCoreError, isReviewCoreError } from './errors.js';
import { hashText } from './hash.js';
import { assertSafeReviewSegment } from './ids.js';
import {
  assertReviewArtifactPath,
  insightsFile,
  progressFile,
  reviewRevisionDir,
  reviewWorkspaceDir,
  reviewsDir,
  snapshotFile,
  workspaceFile,
} from './paths.js';
import { loadReviewQuestionArtifacts } from './questions.js';
import { reconciliationKey } from './reconcile.js';
import { resolveReviewItemContext } from './review-lines.js';
import {
  assertReviewInsights,
  assertReviewProgress,
  assertReviewSnapshot,
  assertReviewWorkspace,
} from './schema.js';
import type {
  ActiveReviewPointer,
  ReviewBundle,
  ReviewInsights,
  ReviewItemProgressPatch,
  ReviewProgress,
  ReviewProgressUpdate,
  ReviewRepository,
  ReviewSnapshot,
  ReviewSource,
  ReviewWorkspace,
} from './types.js';

export interface ReviewStore {
  createRevision(
    workspace: ReviewWorkspace,
    snapshot: ReviewSnapshot,
    insights: ReviewInsights,
    progress: ReviewProgress,
  ): void;
  readBundle(workspaceId: string, revisionId: string): ReviewBundle;
  readWorkspace(workspaceId: string): ReviewWorkspace;
  listWorkspaces(): ReviewWorkspace[];
  findRevisionByFingerprint(workspaceId: string, fingerprint: string): string | undefined;
  writeInitialInsights(workspaceId: string, revisionId: string, insights: ReviewInsights): void;
  finalizeScopeAnalysis(
    workspaceId: string,
    revisionId: string,
    snapshot: ReviewSnapshot,
    insights: ReviewInsights,
    progress: ReviewProgress,
  ): void;
  setCurrentRevision(
    workspaceId: string,
    revisionId: string,
    source: ReviewSource,
    repository?: ReviewRepository,
  ): void;
  isAnalysisFinalized(workspaceId: string, revisionId: string): boolean;
  updateProgress(
    workspaceId: string,
    revisionId: string,
    update: ReviewProgressUpdate,
  ): ReviewProgress;
  patchItemProgress(
    workspaceId: string,
    revisionId: string,
    reviewItemId: string,
    patch: ReviewItemProgressPatch,
  ): ReviewProgress;
  setActiveReview(workspaceId: string, revisionId: string): ActiveReviewPointer;
}

export interface ReviewStoreOptions {
  beforeFinalizedBundlePublish?: () => void;
  beforeProgressPublish?: () => void;
  beforeWorkspacePublish?: () => void;
  openLockFile?: (path: string, flags: 'wx') => number;
  closeLockFile?: (descriptor: number) => void;
  isProcessAlive?: (pid: number) => boolean;
  now?: () => number;
}

interface WorkspaceLockOwner {
  schemaVersion: 1;
  pid: number;
  token: string;
  createdAt: string;
}

const activeWorkspaceLockTokens = new Set<string>();

interface FinalizedRevisionBundle {
  schemaVersion: 1;
  finalized: true;
  snapshot: ReviewSnapshot;
  insights: ReviewInsights;
  progress: ReviewProgress;
}

function readJson(path: string): unknown {
  let serialized: string;
  try {
    serialized = readFileSync(path, 'utf8');
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      throw new ReviewCoreError('review_not_found', `review artifact was not found: ${path}`);
    }
    throw new Error(`unable to read review artifact ${path}: ${detail}`);
  }
  try {
    return JSON.parse(serialized);
  } catch {
    throw new ReviewCoreError('review_corrupt', `review artifact contains invalid JSON: ${path}`);
  }
}

function readValidated<T>(path: string, assertValue: (value: unknown) => asserts value is T): T {
  const value = readJson(path);
  try {
    assertValue(value);
  } catch (error) {
    if (error instanceof ReviewCoreError) throw error;
    throw new ReviewCoreError('review_corrupt', `review artifact failed validation: ${path}`);
  }
  return value;
}

function validateRevisionRelationships(
  workspace: ReviewWorkspace,
  snapshot: ReviewSnapshot,
  insights: ReviewInsights,
  progress: ReviewProgress,
  requireCompleteInsights = false,
): void {
  if (
    workspace.currentRevisionId !== snapshot.revisionId ||
    insights.revisionId !== snapshot.revisionId
  ) {
    throw new Error('review revision artifacts must share the same revision id');
  }
  if (stableJson(workspace.source) !== stableJson(snapshot.source)) {
    throw new Error('review workspace source must match its current snapshot source');
  }

  const itemIds = new Set(snapshot.items.map((item) => item.id));
  if (itemIds.size !== snapshot.items.length) {
    throw new Error('review snapshot contains duplicate review item ids');
  }
  for (const group of insights.groups) {
    if (group.reviewItemIds.some((reviewItemId) => !itemIds.has(reviewItemId))) {
      throw new Error('review insights reference unknown review item');
    }
  }
  if (insights.items.some((insight) => !itemIds.has(insight.reviewItemId))) {
    throw new Error('review insights reference unknown review item');
  }

  if (snapshot.kind === 'scope') {
    const filePaths = new Set(snapshot.files.map((file) => file.path));
    for (const item of snapshot.items) {
      if (item.kind !== 'code-section') {
        throw new Error('scoped review snapshots may contain only code-section items');
      }
      if (!filePaths.has(item.path)) {
        throw new Error('scoped review item references an unknown source file');
      }
    }
  } else {
    const itemsById = new Map(snapshot.items.map((item) => [item.id, item]));
    const linkedItems = new Set<string>();
    const assertLink = (
      reviewItemId: string | undefined,
      contentHash: string | undefined,
      locationHash: string | undefined,
      path: string,
      expectedKind: 'hunk' | 'file',
      label: string,
    ): void => {
      const item = reviewItemId ? itemsById.get(reviewItemId) : undefined;
      if (
        !item ||
        item.kind !== expectedKind ||
        item.path !== path ||
        item.contentHash !== contentHash ||
        item.locationHash !== locationHash ||
        linkedItems.has(item.id)
      ) {
        throw new Error(`${label} must link exactly once to its canonical review item`);
      }
      linkedItems.add(item.id);
    };
    for (const file of snapshot.files) {
      if (file.hunks.length === 0) {
        assertLink(
          file.reviewItemId,
          file.reviewItemContentHash,
          file.reviewItemLocationHash,
          file.path,
          'file',
          'zero-hunk diff file',
        );
        continue;
      }
      if (
        file.reviewItemId !== undefined ||
        file.reviewItemContentHash !== undefined ||
        file.reviewItemLocationHash !== undefined
      ) {
        throw new Error('textual diff files cannot carry a file-level review item link');
      }
      for (const hunk of file.hunks) {
        assertLink(
          hunk.reviewItemId,
          hunk.reviewItemContentHash,
          hunk.reviewItemLocationHash,
          file.path,
          'hunk',
          'diff hunk',
        );
      }
    }
    if (linkedItems.size !== snapshot.items.length) {
      throw new Error('every diff review item must have exactly one file or hunk link');
    }
  }
  for (const item of snapshot.items) {
    const context = resolveReviewItemContext(snapshot, item.id);
    if (
      snapshot.kind === 'scope' &&
      hashText(context.rows.map((row) => row.text).join('\n')) !== item.contentHash
    ) {
      throw new Error('scoped review item content does not match its captured source lines');
    }
    if (snapshot.kind === 'diff' && item.kind === 'file') {
      const file = snapshot.files.find((candidate) => candidate.reviewItemId === item.id);
      if (!file || stableJson(createFileReviewItem(file)) !== stableJson(item)) {
        throw new Error('diff file review item does not match canonical captured metadata');
      }
    }
  }

  const progressIds = Object.keys(progress.items);
  for (const progressId of progressIds) {
    if (!itemIds.has(progressId)) {
      throw new Error('review progress references an unknown review item');
    }
  }
  if (progressIds.length !== itemIds.size) {
    throw new Error('review progress must cover every review item');
  }
  for (const [reviewItemId, itemProgress] of Object.entries(progress.items)) {
    if (itemProgress.status === 'reviewed') {
      if (!itemProgress.reviewedAt)
        throw new Error('reviewed status requires a reviewed timestamp');
      if (itemProgress.inheritedFrom) {
        throw new Error('directly reviewed status cannot carry inherited provenance');
      }
    } else if (itemProgress.status === 'carried-forward') {
      if (!itemProgress.reviewedAt || !itemProgress.inheritedFrom) {
        throw new Error('carried-forward status requires a timestamp and inherited provenance');
      }
      if (
        snapshot.predecessorRevisionId === undefined ||
        itemProgress.inheritedFrom.revisionId !== snapshot.predecessorRevisionId
      ) {
        throw new Error('carried-forward provenance must reference the direct predecessor');
      }
      if (itemProgress.inheritedFrom.reviewItemId.length === 0 || reviewItemId.length === 0) {
        throw new Error('carried-forward provenance must identify both review items');
      }
    } else if (itemProgress.reviewedAt || itemProgress.inheritedFrom) {
      throw new Error('pending or stale review status cannot carry reviewed provenance');
    }
  }
  if (progress.activeReviewItemId && !itemIds.has(progress.activeReviewItemId)) {
    throw new Error('active review item references an unknown review item');
  }
  if (progress.activeFile && !snapshot.files.some((file) => file.path === progress.activeFile)) {
    throw new Error('active review file references an unknown captured file');
  }

  const isPendingInsights = insights.groups.length === 0 && insights.items.length === 0;
  if (requireCompleteInsights && !isPendingInsights && itemIds.size === 0) {
    throw new Error('finalized review analysis for an empty snapshot must be empty');
  }
  if (!isPendingInsights || requireCompleteInsights) {
    const capturedPaths = new Set(snapshot.files.map((file) => file.path));
    for (const insight of insights.items) {
      if (
        insight.evidencePaths.length === 0 ||
        new Set(insight.evidencePaths).size !== insight.evidencePaths.length ||
        insight.evidencePaths.some((path) => !capturedPaths.has(path))
      ) {
        throw new Error('review insight evidence must reference unique captured files');
      }
    }
    if (insights.groups.some((group) => group.reviewItemIds.length === 0)) {
      throw new Error('finalized review groups must not be empty');
    }
    const insightIds = insights.items.map((insight) => insight.reviewItemId);
    if (
      insightIds.length !== itemIds.size ||
      new Set(insightIds).size !== insightIds.length ||
      insightIds.some((id) => !itemIds.has(id))
    ) {
      throw new Error('finalized review insights must cover every review item exactly once');
    }
    const groupedIds = insights.groups.flatMap((group) => group.reviewItemIds);
    if (
      groupedIds.length !== itemIds.size ||
      new Set(groupedIds).size !== groupedIds.length ||
      groupedIds.some((id) => !itemIds.has(id))
    ) {
      throw new Error('finalized review groups must cover every review item exactly once');
    }
    if (new Set(insights.groups.map((group) => group.id)).size !== insights.groups.length) {
      throw new Error('finalized review group ids must be unique');
    }
    if (
      progress.activeGroupId &&
      !insights.groups.some((group) => group.id === progress.activeGroupId)
    ) {
      throw new Error('active review group references an unknown insight group');
    }
  } else {
    if (progress.activeGroupId) {
      throw new Error('pending review analysis cannot select an active group');
    }
    if (insights.groups.length !== insights.items.length) {
      throw new Error('pending review analysis cannot be partially populated');
    }
  }

  for (const group of insights.groups) {
    for (const reviewItemId of group.reviewItemIds) {
      if (!itemIds.has(reviewItemId)) {
        throw new Error('review insights reference unknown review item');
      }
    }
  }
  for (const insight of insights.items) {
    if (!itemIds.has(insight.reviewItemId)) {
      throw new Error('review insights reference unknown review item');
    }
  }
}

function lockFile(projectRoot: string, workspaceId: string): string {
  return assertReviewArtifactPath(
    projectRoot,
    join(reviewWorkspaceDir(projectRoot, workspaceId), '.review-lock'),
  );
}

function finalizedBundleFile(projectRoot: string, workspaceId: string, revisionId: string): string {
  return assertReviewArtifactPath(
    projectRoot,
    join(reviewRevisionDir(projectRoot, workspaceId, revisionId), 'bundle.json'),
  );
}

function validateRevisionPredecessor(
  projectRoot: string,
  workspace: ReviewWorkspace,
  snapshot: ReviewSnapshot,
): void {
  const existingWorkspacePath = workspaceFile(projectRoot, workspace.id);
  if (!existsSync(existingWorkspacePath)) {
    if (snapshot.predecessorRevisionId !== undefined) {
      throw new ReviewCoreError(
        'review_conflict',
        'an initial review revision cannot declare a predecessor',
      );
    }
    return;
  }

  const currentWorkspace = readValidated(existingWorkspacePath, assertReviewWorkspace);
  if (snapshot.predecessorRevisionId !== currentWorkspace.currentRevisionId) {
    throw new ReviewCoreError(
      'review_conflict',
      'review predecessor must be the current workspace revision',
    );
  }
  readValidated(
    snapshotFile(projectRoot, workspace.id, snapshot.predecessorRevisionId),
    assertReviewSnapshot,
  );
}

function readFinalizedBundle(
  projectRoot: string,
  workspaceId: string,
  revisionId: string,
): FinalizedRevisionBundle | undefined {
  const path = finalizedBundleFile(projectRoot, workspaceId, revisionId);
  if (!existsSync(path)) return undefined;
  const value = readJson(path);
  if (
    typeof value !== 'object' ||
    value === null ||
    !('finalized' in value) ||
    value.finalized !== true
  ) {
    throw new ReviewCoreError('review_corrupt', `invalid finalized review bundle ${path}`);
  }
  if (
    !('schemaVersion' in value) ||
    value.schemaVersion !== 1 ||
    !('snapshot' in value) ||
    !('insights' in value) ||
    !('progress' in value)
  ) {
    throw new ReviewCoreError('review_corrupt', `invalid finalized review bundle ${path}`);
  }
  try {
    assertReviewSnapshot(value.snapshot);
    assertReviewInsights(value.insights);
    assertReviewProgress(value.progress);
  } catch {
    throw new ReviewCoreError('review_corrupt', `invalid finalized review bundle ${path}`);
  }
  return {
    schemaVersion: 1,
    finalized: true,
    snapshot: value.snapshot,
    insights: value.insights,
    progress: value.progress,
  };
}

function validateInheritedProgress(
  projectRoot: string,
  workspaceId: string,
  snapshot: ReviewSnapshot,
  progress: ReviewProgress,
): void {
  const inherited = Object.entries(progress.items).filter(
    ([, itemProgress]) => itemProgress.status === 'carried-forward',
  );
  if (inherited.length === 0) return;
  const predecessorRevisionId = snapshot.predecessorRevisionId;
  if (!predecessorRevisionId) {
    throw new Error('carried-forward progress requires a direct predecessor');
  }
  const finalized = readFinalizedBundle(projectRoot, workspaceId, predecessorRevisionId);
  const predecessorSnapshot =
    finalized?.snapshot ??
    readValidated(
      snapshotFile(projectRoot, workspaceId, predecessorRevisionId),
      assertReviewSnapshot,
    );
  const predecessorProgress =
    finalized?.progress ??
    readValidated(
      progressFile(projectRoot, workspaceId, predecessorRevisionId),
      assertReviewProgress,
    );
  if (predecessorSnapshot.revisionId !== predecessorRevisionId) {
    throw new Error('carried-forward predecessor snapshot identity is corrupt');
  }

  for (const [currentId, itemProgress] of inherited) {
    const currentItem = snapshot.items.find((item) => item.id === currentId);
    const predecessorId = itemProgress.inheritedFrom?.reviewItemId;
    const predecessorItem = predecessorSnapshot.items.find((item) => item.id === predecessorId);
    const predecessorState = predecessorId ? predecessorProgress.items[predecessorId] : undefined;
    if (
      !currentItem ||
      !predecessorItem ||
      (predecessorState?.status !== 'reviewed' && predecessorState?.status !== 'carried-forward') ||
      reconciliationKey(currentItem) !== reconciliationKey(predecessorItem)
    ) {
      throw new Error('carried-forward provenance does not match carryable predecessor progress');
    }
    if (currentId === predecessorId) continue;
    const key = reconciliationKey(currentItem);
    const previousMatches = predecessorSnapshot.items.filter((item) => {
      const state = predecessorProgress.items[item.id];
      return (
        reconciliationKey(item) === key &&
        (state?.status === 'reviewed' || state?.status === 'carried-forward')
      );
    });
    const currentMatches = snapshot.items.filter((item) => reconciliationKey(item) === key);
    if (previousMatches.length !== 1 || currentMatches.length !== 1) {
      throw new Error('carried-forward moved-item provenance is ambiguous');
    }
  }
}

function publishFinalizedBundle(
  projectRoot: string,
  workspaceId: string,
  revisionId: string,
  snapshot: ReviewSnapshot,
  insights: ReviewInsights,
  progress: ReviewProgress,
  beforePublish: (() => void) | undefined,
): void {
  beforePublish?.();
  atomicWriteJson(finalizedBundleFile(projectRoot, workspaceId, revisionId), {
    schemaVersion: 1,
    finalized: true,
    snapshot,
    insights,
    progress,
  } satisfies FinalizedRevisionBundle);
}

function publishProgress(
  projectRoot: string,
  workspaceId: string,
  revisionId: string,
  finalized: FinalizedRevisionBundle | undefined,
  progress: ReviewProgress,
  options: ReviewStoreOptions,
): void {
  if (finalized) {
    publishFinalizedBundle(
      projectRoot,
      workspaceId,
      revisionId,
      finalized.snapshot,
      finalized.insights,
      progress,
      options.beforeFinalizedBundlePublish,
    );
    return;
  }
  options.beforeProgressPublish?.();
  atomicWriteJson(progressFile(projectRoot, workspaceId, revisionId), progress);
}

function nextProgressUpdatedAt(previous: string, now: number): string {
  const previousMs = Date.parse(previous);
  return new Date(Number.isFinite(previousMs) ? Math.max(now, previousMs + 1) : now).toISOString();
}

function stableJson(value: unknown): string {
  // Object key order is not part of the snapshot contract; array order is, because captured
  // source files and source lines are ordered records used to derive the immutable fingerprint.
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function storageErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : undefined;
}

function parseWorkspaceLockOwner(raw: string): WorkspaceLockOwner | undefined {
  try {
    const value: unknown = JSON.parse(raw);
    if (
      typeof value !== 'object' ||
      value === null ||
      !('schemaVersion' in value) ||
      value.schemaVersion !== 1 ||
      !('pid' in value) ||
      !Number.isSafeInteger(value.pid) ||
      Number(value.pid) <= 0 ||
      !('token' in value) ||
      typeof value.token !== 'string' ||
      value.token.length === 0 ||
      !('createdAt' in value) ||
      typeof value.createdAt !== 'string' ||
      !Number.isFinite(Date.parse(value.createdAt))
    ) {
      return undefined;
    }
    return value as WorkspaceLockOwner;
  } catch {
    return undefined;
  }
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return storageErrorCode(error) === 'EPERM';
  }
}

function recoverAbandonedWorkspaceLock(
  projectRoot: string,
  path: string,
  isProcessAlive: (pid: number) => boolean,
): boolean {
  assertReviewArtifactPath(projectRoot, path);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, 'r');
    const inspected = fstatSync(descriptor);
    const owner = parseWorkspaceLockOwner(readFileSync(descriptor, 'utf8'));
    if (!owner) return false;
    const isActiveHere = owner.pid === process.pid && activeWorkspaceLockTokens.has(owner.token);
    const isAliveElsewhere = owner.pid !== process.pid && isProcessAlive(owner.pid);
    if (isActiveHere || isAliveElsewhere) return false;

    // Revalidate both identity and owner bytes immediately before unlinking. This narrows the
    // filesystem ABA window without claiming perfect TOCTOU resistance from path-based Node APIs.
    assertReviewArtifactPath(projectRoot, path);
    const current = lstatSync(path);
    const currentOwner = parseWorkspaceLockOwner(readFileSync(path, 'utf8'));
    if (
      current.dev !== inspected.dev ||
      current.ino !== inspected.ino ||
      currentOwner?.token !== owner.token ||
      currentOwner.pid !== owner.pid
    ) {
      return false;
    }
    unlinkSync(path);
    return true;
  } catch (error) {
    if (storageErrorCode(error) === 'ENOENT') return true;
    return false;
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Inspection cleanup cannot authorize stealing a lock.
      }
    }
  }
}

function releaseOwnedWorkspaceLock(
  projectRoot: string,
  path: string,
  owner: WorkspaceLockOwner,
): void {
  assertReviewArtifactPath(projectRoot, path);
  let persisted: WorkspaceLockOwner | undefined;
  try {
    persisted = parseWorkspaceLockOwner(readFileSync(path, 'utf8'));
  } catch (error) {
    if (storageErrorCode(error) === 'ENOENT') return;
    throw error;
  }
  if (persisted?.token !== owner.token || persisted.pid !== owner.pid) {
    throw new ReviewCoreError('review_internal', 'review workspace lock ownership changed');
  }
  unlinkSync(path);
}

function withWorkspaceLock<T>(
  projectRoot: string,
  workspaceId: string,
  operation: () => T,
  openLockFile: (path: string, flags: 'wx') => number = openSync,
  closeLockFile: (descriptor: number) => void = closeSync,
  isProcessAlive: (pid: number) => boolean = defaultIsProcessAlive,
): T {
  const workspaceDirectory = reviewWorkspaceDir(projectRoot, workspaceId);
  mkdirSync(workspaceDirectory, { recursive: true });
  const lockPath = lockFile(projectRoot, workspaceId);
  const owner: WorkspaceLockOwner = {
    schemaVersion: 1,
    pid: process.pid,
    token: randomUUID(),
    createdAt: new Date().toISOString(),
  };
  let descriptor: number | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      assertReviewArtifactPath(projectRoot, lockPath);
      descriptor = openLockFile(lockPath, 'wx');
      break;
    } catch (error) {
      if (storageErrorCode(error) !== 'EEXIST') {
        throw new ReviewCoreError('review_internal', 'unable to acquire review workspace lock');
      }
      if (attempt === 0 && recoverAbandonedWorkspaceLock(projectRoot, lockPath, isProcessAlive)) {
        continue;
      }
      throw new ReviewCoreError('review_busy', 'review workspace is busy; retry the operation');
    }
  }
  if (descriptor === undefined) {
    throw new ReviewCoreError('review_internal', 'unable to acquire review workspace lock');
  }

  let acquired = false;
  try {
    writeFileSync(descriptor, `${JSON.stringify(owner)}\n`, 'utf8');
    fsyncSync(descriptor);
    activeWorkspaceLockTokens.add(owner.token);
    acquired = true;
  } catch (error) {
    try {
      closeLockFile(descriptor);
    } finally {
      try {
        unlinkSync(lockPath);
      } catch {
        // The original acquisition error remains authoritative.
      }
    }
    throw error;
  }

  let result: T | undefined;
  let operationError: unknown;
  try {
    result = operation();
  } catch (error) {
    operationError = error;
  }

  let cleanupError: unknown;
  if (acquired) activeWorkspaceLockTokens.delete(owner.token);
  try {
    closeLockFile(descriptor);
  } catch (error) {
    cleanupError = error;
  }
  try {
    releaseOwnedWorkspaceLock(projectRoot, lockPath, owner);
  } catch (error) {
    cleanupError ??= error;
  }
  if (operationError !== undefined) throw operationError;
  if (cleanupError !== undefined) throw cleanupError;
  return result as T;
}

export function createReviewStore(
  projectRoot: string,
  options: ReviewStoreOptions = {},
): ReviewStore {
  const withLock = <T>(workspaceId: string, operation: () => T): T =>
    withWorkspaceLock(
      projectRoot,
      workspaceId,
      operation,
      options.openLockFile,
      options.closeLockFile,
      options.isProcessAlive,
    );
  return {
    createRevision(workspace, snapshot, insights, progress): void {
      assertReviewWorkspace(workspace);
      assertReviewSnapshot(snapshot);
      assertReviewInsights(insights);
      assertReviewProgress(progress);
      validateRevisionRelationships(workspace, snapshot, insights, progress);

      withLock(workspace.id, () => {
        const revisionDir = reviewRevisionDir(projectRoot, workspace.id, snapshot.revisionId);
        if (existsSync(revisionDir)) {
          const existingWorkspacePath = workspaceFile(projectRoot, workspace.id);
          const currentWorkspace = existsSync(existingWorkspacePath)
            ? readValidated(existingWorkspacePath, assertReviewWorkspace)
            : undefined;
          const canRecoverPointer = currentWorkspace
            ? currentWorkspace.currentRevisionId === snapshot.predecessorRevisionId
            : snapshot.predecessorRevisionId === undefined;
          const existingSnapshot = readValidated(
            snapshotFile(projectRoot, workspace.id, snapshot.revisionId),
            assertReviewSnapshot,
          );
          const existingInsights = readValidated(
            insightsFile(projectRoot, workspace.id, snapshot.revisionId),
            assertReviewInsights,
          );
          const existingProgress = readValidated(
            progressFile(projectRoot, workspace.id, snapshot.revisionId),
            assertReviewProgress,
          );
          const isExactOrphan =
            canRecoverPointer &&
            stableJson(existingSnapshot) === stableJson(snapshot) &&
            stableJson(existingInsights) === stableJson(insights) &&
            stableJson(existingProgress) === stableJson(progress);
          if (!isExactOrphan) {
            throw new ReviewCoreError('review_conflict', 'review revision already exists');
          }
          options.beforeWorkspacePublish?.();
          atomicWriteJson(existingWorkspacePath, workspace);
          return;
        }
        validateRevisionPredecessor(projectRoot, workspace, snapshot);
        validateInheritedProgress(projectRoot, workspace.id, snapshot, progress);
        const stagingRoot = assertReviewArtifactPath(
          projectRoot,
          join(reviewWorkspaceDir(projectRoot, workspace.id), '.revision-staging'),
        );
        mkdirSync(stagingRoot, { recursive: true });
        const temporaryDir = assertReviewArtifactPath(
          projectRoot,
          join(stagingRoot, `${snapshot.revisionId}-${process.pid}-${randomUUID()}`),
        );
        try {
          mkdirSync(dirname(revisionDir), { recursive: true });
          mkdirSync(temporaryDir, { recursive: true });
          mkdirSync(join(temporaryDir, 'questions'), { recursive: true });
          mkdirSync(join(temporaryDir, 'answers'), { recursive: true });
          atomicWriteJson(join(temporaryDir, 'snapshot.json'), snapshot);
          atomicWriteJson(join(temporaryDir, 'insights.json'), insights);
          atomicWriteJson(join(temporaryDir, 'progress.json'), progress);
          renameSync(temporaryDir, revisionDir);
          options.beforeWorkspacePublish?.();
          atomicWriteJson(workspaceFile(projectRoot, workspace.id), workspace);
        } catch (error) {
          rmSync(temporaryDir, { recursive: true, force: true });
          throw error;
        }
      });
    },

    readBundle(workspaceId, revisionId): ReviewBundle {
      try {
        const workspace = this.readWorkspace(workspaceId);
        if (workspace.id !== workspaceId) {
          throw new Error('review workspace id does not match requested workspace');
        }
        const finalized = readFinalizedBundle(projectRoot, workspaceId, revisionId);
        const snapshot =
          finalized?.snapshot ??
          readValidated(snapshotFile(projectRoot, workspaceId, revisionId), assertReviewSnapshot);
        const insights =
          finalized?.insights ??
          readValidated(insightsFile(projectRoot, workspaceId, revisionId), assertReviewInsights);
        const progress =
          finalized?.progress ??
          readValidated(progressFile(projectRoot, workspaceId, revisionId), assertReviewProgress);
        const revisionWorkspace: ReviewWorkspace = {
          ...workspace,
          source: snapshot.source,
          currentRevisionId: snapshot.revisionId,
        };
        validateRevisionRelationships(
          revisionWorkspace,
          snapshot,
          insights,
          progress,
          finalized !== undefined,
        );
        validateInheritedProgress(projectRoot, workspaceId, snapshot, progress);
        const { questions, answers } = loadReviewQuestionArtifacts(
          projectRoot,
          { workspaceId, revisionId },
          snapshot,
        );
        return {
          workspace: revisionWorkspace,
          snapshot,
          insights,
          progress,
          questions,
          answers,
          sourceChanged: false,
        };
      } catch (error) {
        if (error instanceof ReviewCoreError) throw error;
        const detail = error instanceof Error ? error.message : 'invalid review bundle artifact';
        throw new ReviewCoreError('review_corrupt', detail);
      }
    },

    readWorkspace(workspaceId): ReviewWorkspace {
      const workspace = readValidated(
        workspaceFile(projectRoot, workspaceId),
        assertReviewWorkspace,
      );
      if (workspace.id !== workspaceId) {
        throw new ReviewCoreError(
          'review_corrupt',
          'review workspace id does not match requested workspace',
        );
      }
      return workspace;
    },

    listWorkspaces(): ReviewWorkspace[] {
      const directory = reviewsDir(projectRoot);
      if (!existsSync(directory)) return [];
      return readdirSync(directory)
        .sort()
        .filter((entry) => {
          try {
            assertSafeReviewSegment(entry, 'workspace');
            return true;
          } catch {
            return false;
          }
        })
        .map((entry) => this.readWorkspace(entry));
    },

    findRevisionByFingerprint(workspaceId, fingerprint): string | undefined {
      const revisionDirectory = reviewWorkspaceDir(projectRoot, workspaceId);
      if (!existsSync(revisionDirectory)) return undefined;
      const revisionsDirectory = assertReviewArtifactPath(
        projectRoot,
        join(revisionDirectory, 'revisions'),
      );
      if (!existsSync(revisionsDirectory)) return undefined;
      const revisionIds = readdirSync(revisionsDirectory)
        .sort()
        .filter((revisionId) => {
          try {
            assertSafeReviewSegment(revisionId, 'revision');
            return true;
          } catch {
            return false;
          }
        });
      for (const revisionId of revisionIds) {
        const path = snapshotFile(projectRoot, workspaceId, revisionId);
        if (!existsSync(path)) continue;
        const snapshot = readValidated(path, assertReviewSnapshot);
        if (snapshot.revisionId !== revisionId) continue;
        if (snapshot.fingerprint === fingerprint) return revisionId;
      }
      return undefined;
    },

    writeInitialInsights(workspaceId, revisionId, insights): void {
      withLock(workspaceId, () => {
        if (readFinalizedBundle(projectRoot, workspaceId, revisionId)) {
          throw new ReviewCoreError(
            'review_conflict',
            'review analysis already exists and is immutable',
          );
        }
        const workspace = this.readWorkspace(workspaceId);
        const snapshot = readValidated(
          snapshotFile(projectRoot, workspaceId, revisionId),
          assertReviewSnapshot,
        );
        const current = readValidated(
          insightsFile(projectRoot, workspaceId, revisionId),
          assertReviewInsights,
        );
        if (current.revisionId !== revisionId) {
          throw new Error('stored review insights revision does not match requested revision');
        }
        if (current.groups.length > 0 || current.items.length > 0) {
          throw new ReviewCoreError(
            'review_conflict',
            'review analysis already exists and is immutable',
          );
        }
        if (insights.revisionId !== revisionId) {
          throw new Error('review insights revision does not match requested revision');
        }
        assertReviewInsights(insights);
        const progress = readValidated(
          progressFile(projectRoot, workspaceId, revisionId),
          assertReviewProgress,
        );
        validateRevisionRelationships(
          { ...workspace, currentRevisionId: revisionId },
          snapshot,
          insights,
          progress,
          true,
        );
        validateInheritedProgress(projectRoot, workspaceId, snapshot, progress);
        publishFinalizedBundle(
          projectRoot,
          workspaceId,
          revisionId,
          snapshot,
          insights,
          progress,
          options.beforeFinalizedBundlePublish,
        );
      });
    },

    finalizeScopeAnalysis(workspaceId, revisionId, snapshot, insights, progress): void {
      withLock(workspaceId, () => {
        if (readFinalizedBundle(projectRoot, workspaceId, revisionId)) {
          throw new ReviewCoreError(
            'review_conflict',
            'review analysis already exists and is immutable',
          );
        }
        const workspace = this.readWorkspace(workspaceId);
        const existingSnapshot = readValidated(
          snapshotFile(projectRoot, workspaceId, revisionId),
          assertReviewSnapshot,
        );
        const currentInsights = readValidated(
          insightsFile(projectRoot, workspaceId, revisionId),
          assertReviewInsights,
        );
        if (existingSnapshot.kind !== 'scope' || snapshot.kind !== 'scope') {
          throw new Error('only scoped review snapshots can be finalized with code sections');
        }
        if (currentInsights.groups.length > 0 || currentInsights.items.length > 0) {
          throw new ReviewCoreError(
            'review_conflict',
            'review analysis already exists and is immutable',
          );
        }
        const immutablePending = { ...existingSnapshot, items: [] };
        const immutableProposed = { ...snapshot, items: [] };
        if (stableJson(immutablePending) !== stableJson(immutableProposed)) {
          throw new Error('scoped finalization cannot modify immutable captured source data');
        }
        validateRevisionRelationships(
          { ...workspace, currentRevisionId: revisionId },
          snapshot,
          insights,
          progress,
          true,
        );
        validateInheritedProgress(projectRoot, workspaceId, snapshot, progress);
        assertReviewSnapshot(snapshot);
        assertReviewInsights(insights);
        assertReviewProgress(progress);
        publishFinalizedBundle(
          projectRoot,
          workspaceId,
          revisionId,
          snapshot,
          insights,
          progress,
          options.beforeFinalizedBundlePublish,
        );
      });
    },

    setCurrentRevision(workspaceId, revisionId, source, repository): void {
      withLock(workspaceId, () => {
        const snapshot = readValidated(
          snapshotFile(projectRoot, workspaceId, revisionId),
          assertReviewSnapshot,
        );
        if (snapshot.revisionId !== revisionId) {
          throw new ReviewCoreError(
            'review_corrupt',
            'review snapshot revision does not match requested revision',
          );
        }
        if (stableJson(source) !== stableJson(snapshot.source)) {
          throw new ReviewCoreError(
            'review_conflict',
            'review workspace source must match the target snapshot source',
          );
        }
        let workspace: ReviewWorkspace;
        try {
          workspace = this.readWorkspace(workspaceId);
        } catch (error) {
          if (!isReviewCoreError(error) || error.code !== 'review_not_found') throw error;
          const insights = readValidated(
            insightsFile(projectRoot, workspaceId, revisionId),
            assertReviewInsights,
          );
          const progress = readValidated(
            progressFile(projectRoot, workspaceId, revisionId),
            assertReviewProgress,
          );
          workspace = {
            schemaVersion: 1,
            id: workspaceId,
            repository: repository ?? { root: projectRoot, name: basename(projectRoot) },
            source,
            currentRevisionId: revisionId,
            createdAt: snapshot.createdAt,
            updatedAt: snapshot.createdAt,
          };
          assertReviewWorkspace(workspace);
          validateRevisionRelationships(workspace, snapshot, insights, progress);
          validateInheritedProgress(projectRoot, workspaceId, snapshot, progress);
        }
        const next: ReviewWorkspace = {
          ...workspace,
          source,
          currentRevisionId: revisionId,
          updatedAt: nextProgressUpdatedAt(workspace.updatedAt, options.now?.() ?? Date.now()),
        };
        assertReviewWorkspace(next);
        atomicWriteJson(workspaceFile(projectRoot, workspaceId), next);
      });
    },

    isAnalysisFinalized(workspaceId, revisionId): boolean {
      return readFinalizedBundle(projectRoot, workspaceId, revisionId) !== undefined;
    },

    updateProgress(workspaceId, revisionId, update): ReviewProgress {
      return withLock(workspaceId, () => {
        const finalized = readFinalizedBundle(projectRoot, workspaceId, revisionId);
        const snapshot =
          finalized?.snapshot ??
          readValidated(snapshotFile(projectRoot, workspaceId, revisionId), assertReviewSnapshot);
        const insights =
          finalized?.insights ??
          readValidated(insightsFile(projectRoot, workspaceId, revisionId), assertReviewInsights);
        const current =
          finalized?.progress ??
          readValidated(progressFile(projectRoot, workspaceId, revisionId), assertReviewProgress);
        const next: ReviewProgress = {
          ...current,
          ...update,
          items: {
            ...current.items,
            ...Object.fromEntries(
              Object.entries(update.items ?? {}).map(([reviewItemId, item]) => [
                reviewItemId,
                item.status === 'reviewed' && !item.reviewedAt
                  ? {
                      ...item,
                      reviewedAt: new Date(options.now?.() ?? Date.now()).toISOString(),
                    }
                  : item,
              ]),
            ),
          },
          updatedAt: nextProgressUpdatedAt(current.updatedAt, options.now?.() ?? Date.now()),
        };
        assertReviewProgress(next);
        const workspace = this.readWorkspace(workspaceId);
        validateRevisionRelationships(
          { ...workspace, source: snapshot.source, currentRevisionId: revisionId },
          snapshot,
          insights,
          next,
          finalized !== undefined,
        );
        validateInheritedProgress(projectRoot, workspaceId, snapshot, next);
        publishProgress(projectRoot, workspaceId, revisionId, finalized, next, options);
        return next;
      });
    },

    patchItemProgress(workspaceId, revisionId, reviewItemId, patch): ReviewProgress {
      return withLock(workspaceId, () => {
        const finalized = readFinalizedBundle(projectRoot, workspaceId, revisionId);
        const snapshot =
          finalized?.snapshot ??
          readValidated(snapshotFile(projectRoot, workspaceId, revisionId), assertReviewSnapshot);
        const insights =
          finalized?.insights ??
          readValidated(insightsFile(projectRoot, workspaceId, revisionId), assertReviewInsights);
        const current =
          finalized?.progress ??
          readValidated(progressFile(projectRoot, workspaceId, revisionId), assertReviewProgress);
        const currentItem = current.items[reviewItemId] ?? { status: 'needs-review' as const };
        const status = patch.status ?? currentItem.status;
        const note = patch.note === undefined ? currentItem.note : (patch.note ?? undefined);
        const reviewedAt =
          status === 'reviewed'
            ? patch.status === 'reviewed'
              ? new Date(options.now?.() ?? Date.now()).toISOString()
              : currentItem.reviewedAt
            : undefined;
        const item = {
          status,
          ...(note === undefined ? {} : { note }),
          ...(reviewedAt === undefined ? {} : { reviewedAt }),
          ...(patch.status === undefined && currentItem.inheritedFrom
            ? { inheritedFrom: currentItem.inheritedFrom }
            : {}),
        };
        const next: ReviewProgress = {
          ...current,
          items: { ...current.items, [reviewItemId]: item },
          updatedAt: nextProgressUpdatedAt(current.updatedAt, options.now?.() ?? Date.now()),
        };
        assertReviewProgress(next);
        const workspace = this.readWorkspace(workspaceId);
        validateRevisionRelationships(
          { ...workspace, source: snapshot.source, currentRevisionId: revisionId },
          snapshot,
          insights,
          next,
          finalized !== undefined,
        );
        validateInheritedProgress(projectRoot, workspaceId, snapshot, next);
        publishProgress(projectRoot, workspaceId, revisionId, finalized, next, options);
        return next;
      });
    },

    setActiveReview(workspaceId, revisionId): ActiveReviewPointer {
      return withLock(workspaceId, () => {
        this.readBundle(workspaceId, revisionId);
        const pointer: ActiveReviewPointer = {
          schemaVersion: 1,
          workspaceId,
          revisionId,
          updatedAt: new Date(options.now?.() ?? Date.now()).toISOString(),
        };
        atomicWriteJson(join(projectRoot, '.synergy', 'active-review.json'), pointer);
        return pointer;
      });
    },
  };
}
