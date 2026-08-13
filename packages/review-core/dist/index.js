import {
  buildRemovalStrips,
  deriveRemovalRuns,
  deriveReviewReadiness,
  deriveSnapshotRemovalRuns,
  resolveRemovalTarget,
  reviewRowId
} from "./chunk-XNYFNTV3.js";
import {
  buildDiffSnapshot,
  capturePr,
  captureReviewSource,
  captureScope,
  captureStaged,
  captureUnstaged,
  compareReviewSourceFreshness,
  createFileReviewItem,
  createHunkReviewItem,
  excludePathspecs,
  findDuplicateReviewItemId,
  hashText,
  isPathExcluded,
  normalizeExcludePattern,
  normalizeExcludes,
  normalizeExcludesOrUndefined,
  parseUnifiedDiff,
  recaptureReviewSource,
  repositoryName,
  resolveRepositoryRoot,
  systemCommandRunner
} from "./chunk-MRNQSRL4.js";

// src/atomic.ts
import { renameSync, writeFileSync } from "node:fs";
function atomicWriteJson(path, value) {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}
`, "utf8");
  renameSync(temporary, path);
}

// src/errors.ts
var ReviewCoreError = class extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "ReviewCoreError";
  }
};
function isReviewCoreError(error) {
  return error instanceof ReviewCoreError;
}

// src/source-capture-async.ts
import { Worker } from "node:worker_threads";
var DEFAULT_FRESHNESS_TIMEOUT_MS = 3e4;
var ReviewFreshnessAsyncError = class extends Error {
  constructor(code) {
    super(
      code === "freshness_aborted" ? "review source freshness check was aborted" : code === "freshness_timeout" ? "review source freshness check timed out" : "review source freshness worker failed"
    );
    this.code = code;
    this.name = "ReviewFreshnessAsyncError";
  }
};
function isWorkerSuccess(message) {
  if (typeof message !== "object" || message === null || !("ok" in message)) return false;
  if (message.ok !== true || !("result" in message)) return false;
  const result = message.result;
  return typeof result === "object" && result !== null && "sourceChanged" in result && typeof result.sourceChanged === "boolean" && "captureFailed" in result && typeof result.captureFailed === "boolean";
}
var defaultWorkerFactory = ({ url, data }) => {
  const worker = new Worker(url, { workerData: data });
  return {
    onMessage: (listener) => worker.once("message", listener),
    onError: (listener) => worker.once("error", listener),
    onExit: (listener) => worker.once("exit", listener),
    terminate: () => {
      void worker.terminate();
    }
  };
};
function compareReviewSourceFreshnessAsync(snapshot, root, options = {}) {
  if (options.signal?.aborted) {
    return Promise.reject(new ReviewFreshnessAsyncError("freshness_aborted"));
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_FRESHNESS_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return Promise.reject(new ReviewFreshnessAsyncError("freshness_timeout"));
  }
  let worker;
  try {
    worker = (options.workerFactory ?? defaultWorkerFactory)({
      url: new URL("./source-capture-worker.js", import.meta.url),
      data: { snapshot, root }
    });
  } catch {
    return Promise.reject(new ReviewFreshnessAsyncError("freshness_worker_failed"));
  }
  return new Promise((resolve2, reject) => {
    let settled = false;
    const timing = {};
    const cleanup = () => {
      if (timing.timeout !== void 0) clearTimeout(timing.timeout);
      options.signal?.removeEventListener("abort", handleAbort);
      worker.terminate();
    };
    const rejectOnce = (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new ReviewFreshnessAsyncError(code));
    };
    const handleAbort = () => rejectOnce("freshness_aborted");
    worker.onMessage((message) => {
      if (settled) return;
      if (!isWorkerSuccess(message)) {
        rejectOnce("freshness_worker_failed");
        return;
      }
      settled = true;
      cleanup();
      resolve2(message.result);
    });
    worker.onError(() => rejectOnce("freshness_worker_failed"));
    worker.onExit(() => rejectOnce("freshness_worker_failed"));
    options.signal?.addEventListener("abort", handleAbort, { once: true });
    if (options.signal?.aborted) {
      handleAbort();
      return;
    }
    timing.timeout = setTimeout(() => rejectOnce("freshness_timeout"), timeoutMs);
  });
}

// src/removal-hash.ts
function removalRunHash(texts) {
  return hashText(texts.join("\n"));
}

// src/reconcile.ts
function isCarryable(progress) {
  return progress?.status === "reviewed" || progress?.status === "carried-forward";
}
function cloneProgress(progress) {
  if (!progress.inheritedFrom) return { ...progress };
  return { ...progress, inheritedFrom: { ...progress.inheritedFrom } };
}
function indexByReconciliationKey(items) {
  const index = /* @__PURE__ */ new Map();
  for (const item of items) {
    const key = reconciliationKey(item);
    const matches = index.get(key) ?? [];
    matches.push(item);
    index.set(key, matches);
  }
  return index;
}
function reconciliationKey(item) {
  return [item.path, item.kind, item.contentHash, item.locationHash].join(":");
}
function carryForwardFileInsights(previousInsights, nextSnapshot, carriedItemIds) {
  const previousFiles = previousInsights.files;
  if (!previousFiles || previousFiles.length === 0) return void 0;
  const nextItemsByPath = /* @__PURE__ */ new Map();
  for (const item of nextSnapshot.items) {
    const list = nextItemsByPath.get(item.path) ?? [];
    list.push(item);
    nextItemsByPath.set(item.path, list);
  }
  const carried = previousFiles.filter((file) => {
    const items = nextItemsByPath.get(file.path);
    return items?.every((item) => carriedItemIds.has(item.id)) ?? false;
  });
  return carried.length > 0 ? carried : void 0;
}
function carryForwardRemovals(previousInsights, previousSnapshot, currentSnapshot, inheritance) {
  const previousRemovals = previousInsights.removals ?? [];
  if (previousRemovals.length === 0) return void 0;
  const byItem = (runs) => {
    const index = /* @__PURE__ */ new Map();
    for (const run of runs) {
      const list = index.get(run.reviewItemId) ?? [];
      list.push(run);
      index.set(run.reviewItemId, list);
    }
    return index;
  };
  const previousRuns = byItem(deriveSnapshotRemovalRuns(previousSnapshot));
  const currentRuns = byItem(deriveSnapshotRemovalRuns(currentSnapshot));
  const carried = [];
  for (const [currentItemId, previousItemId] of inheritance) {
    const before = previousRuns.get(previousItemId) ?? [];
    const after = currentRuns.get(currentItemId) ?? [];
    if (before.length !== after.length) continue;
    for (const [ordinal, beforeRun] of before.entries()) {
      const afterRun = after[ordinal];
      if (removalRunHash(beforeRun.texts) !== removalRunHash(afterRun.texts)) continue;
      const rationale = previousRemovals.find(
        (candidate) => candidate.reviewItemId === previousItemId && candidate.run.start === beforeRun.start && candidate.run.end === beforeRun.end
      );
      if (!rationale) continue;
      carried.push({
        ...rationale,
        reviewItemId: currentItemId,
        run: { path: afterRun.path, start: afterRun.start, end: afterRun.end }
      });
    }
  }
  return carried.length > 0 ? carried : void 0;
}
function reconcileReview(previous, currentSnapshot, now) {
  const previousItemsById = new Map(previous.snapshot.items.map((item) => [item.id, item]));
  const exactStateIds = /* @__PURE__ */ new Set();
  const items = {};
  for (const currentItem of currentSnapshot.items) {
    const previousItem = previousItemsById.get(currentItem.id);
    const previousState = previous.progress.items[currentItem.id];
    if (!previousItem || !previousState || reconciliationKey(previousItem) !== reconciliationKey(currentItem)) {
      continue;
    }
    exactStateIds.add(currentItem.id);
    items[currentItem.id] = previousState.status === "reviewed" || previousState.status === "carried-forward" ? {
      status: "carried-forward",
      inheritedFrom: {
        revisionId: previous.snapshot.revisionId,
        reviewItemId: previousItem.id
      },
      reviewedAt: now
    } : cloneProgress(previousState);
  }
  const previousCandidates = previous.snapshot.items.filter(
    (item) => !exactStateIds.has(item.id) && isCarryable(previous.progress.items[item.id])
  );
  const currentCandidates = currentSnapshot.items.filter((item) => !exactStateIds.has(item.id));
  const previousMatches = indexByReconciliationKey(previousCandidates);
  const currentMatches = indexByReconciliationKey(currentCandidates);
  for (const currentItem of currentCandidates) {
    const key = reconciliationKey(currentItem);
    const oldMatches = previousMatches.get(key) ?? [];
    const newMatches = currentMatches.get(key) ?? [];
    if (oldMatches.length === 1 && newMatches.length === 1) {
      const priorItem = oldMatches[0];
      items[currentItem.id] = {
        status: "carried-forward",
        inheritedFrom: {
          revisionId: previous.snapshot.revisionId,
          reviewItemId: priorItem.id
        },
        reviewedAt: now
      };
      continue;
    }
    items[currentItem.id] = oldMatches.length > 0 ? { status: "stale" } : { status: "needs-review" };
  }
  const carriedItemIds = new Set(
    Object.entries(items).filter(([, itemProgress]) => itemProgress.status === "carried-forward").map(([id]) => id)
  );
  const files = carryForwardFileInsights(previous.insights, currentSnapshot, carriedItemIds);
  const inheritance = /* @__PURE__ */ new Map();
  for (const id of exactStateIds) {
    inheritance.set(id, id);
  }
  for (const id of carriedItemIds) {
    const inheritedFrom = items[id]?.inheritedFrom;
    if (inheritedFrom) inheritance.set(id, inheritedFrom.reviewItemId);
  }
  const removals = carryForwardRemovals(
    previous.insights,
    previous.snapshot,
    currentSnapshot,
    inheritance
  );
  return {
    schemaVersion: 1,
    updatedAt: now,
    items,
    insights: { files, ...removals ? { removals } : {} }
  };
}

// src/review-lines.ts
function sameSemanticItem(left, right) {
  return left.kind === right.kind && left.path === right.path && left.label === right.label && left.range.start === right.range.start && left.range.end === right.range.end && left.contentHash === right.contentHash && left.locationHash === right.locationHash;
}
function scopeRows(snapshot, item) {
  if (snapshot.kind !== "scope" || item.kind !== "code-section") {
    throw new Error("review item kind does not match scoped snapshot");
  }
  const file = snapshot.files.find((candidate) => candidate.path === item.path);
  if (!file || file.binary) throw new Error("review item source file is unavailable");
  const lines = file.lines.filter(
    (line) => line.number >= item.range.start && line.number <= item.range.end
  );
  if (lines.length !== item.range.end - item.range.start + 1) {
    throw new Error("review item range is not complete in its source file");
  }
  return lines.map((line, position) => ({
    id: reviewRowId(item.id, position),
    kind: "scope",
    line: line.number,
    text: line.text
  }));
}
function exactHunk(snapshot, item) {
  if (snapshot.kind !== "diff" || item.kind !== "hunk") {
    throw new Error("review item kind does not match diff snapshot");
  }
  const file = snapshot.files.find((candidate) => candidate.path === item.path);
  if (!file) throw new Error("review item diff file is unavailable");
  const matchingHunks = file.hunks.filter(
    (candidate) => candidate.reviewItemId === item.id && candidate.reviewItemContentHash === item.contentHash && candidate.reviewItemLocationHash === item.locationHash && sameSemanticItem(createHunkReviewItem(file.path, candidate), item)
  );
  if (matchingHunks.length !== 1) {
    throw new Error("review item does not match an exact immutable hunk");
  }
  return matchingHunks[0];
}
function diffRows(snapshot, item) {
  if (snapshot.kind === "diff" && item.kind === "file") {
    const matchingFiles = snapshot.files.filter(
      (file) => file.path === item.path && file.reviewItemId === item.id && file.reviewItemContentHash === item.contentHash && file.reviewItemLocationHash === item.locationHash
    );
    if (matchingFiles.length !== 1) {
      throw new Error("review item does not match an exact immutable file change");
    }
    return [];
  }
  return exactHunk(snapshot, item).lines.map((line, position) => ({
    id: reviewRowId(item.id, position),
    kind: line.kind,
    oldLine: line.oldLine,
    newLine: line.newLine,
    text: line.text,
    ...line.noNewlineAtEnd === void 0 ? {} : { noNewlineAtEnd: line.noNewlineAtEnd }
  }));
}
function resolveReviewItemContext(snapshot, reviewItemId) {
  const matchingItems = snapshot.items.filter((candidate) => candidate.id === reviewItemId);
  if (matchingItems.length === 0) throw new Error("unknown review item");
  if (matchingItems.length !== 1) throw new Error("review item identity is ambiguous");
  const item = matchingItems[0];
  const rows = snapshot.kind === "scope" ? scopeRows(snapshot, item) : diffRows(snapshot, item);
  return { item, rows };
}
function resolveReviewLineSelection(snapshot, reviewItemId, selectedLineIds) {
  if (selectedLineIds.length === 0 || new Set(selectedLineIds).size !== selectedLineIds.length) {
    throw new Error("review line selection must contain unique row ids");
  }
  const context = resolveReviewItemContext(snapshot, reviewItemId);
  const rowIds = new Set(context.rows.map((row) => row.id));
  if (selectedLineIds.some((lineId) => !rowIds.has(lineId))) {
    throw new Error("unknown review row in line selection");
  }
  return { kind: snapshot.kind, selectedLineIds: [...selectedLineIds] };
}

// src/scope.ts
var CONTEXT_RADIUS = 2;
function assertSafeRepositoryPath(path) {
  if (path.length === 0 || path.startsWith("/") || path.startsWith("\\") || path.split(/[\\/]/u).some((segment) => segment === "." || segment === "..")) {
    throw new Error(`invalid repository-relative path: ${path}`);
  }
}
function assertUniqueFiles(files) {
  const paths = /* @__PURE__ */ new Set();
  for (const file of files) {
    assertSafeRepositoryPath(file.path);
    if (paths.has(file.path)) throw new Error(`duplicate source file: ${file.path}`);
    paths.add(file.path);
  }
}
function findSectionLines(file, section) {
  const startIndex = file.lines.findIndex((line) => line.number === section.start);
  const endIndex = file.lines.findIndex((line) => line.number === section.end);
  if (startIndex === -1 || endIndex === -1 || startIndex > endIndex) {
    throw new Error(`section range is outside ${section.path}`);
  }
  return file.lines.slice(startIndex, endIndex + 1);
}
function validateAndBuildSection(snapshot, section) {
  assertSafeRepositoryPath(section.path);
  if (section.label.trim().length === 0) throw new Error("section label cannot be empty");
  if (!Number.isInteger(section.start) || !Number.isInteger(section.end) || section.start > section.end) {
    throw new Error("section range must select at least one line");
  }
  const file = snapshot.files.find((candidate) => candidate.path === section.path);
  if (!file) throw new Error(`section path does not exist: ${section.path}`);
  if (file.binary) throw new Error(`cannot create a section for binary file: ${section.path}`);
  const selectedLines = findSectionLines(file, section);
  if (selectedLines.length === 0) throw new Error("section range must select at least one line");
  const startIndex = file.lines.indexOf(selectedLines[0]);
  const endIndex = startIndex + selectedLines.length;
  const surrounding = file.lines.slice(
    Math.max(0, startIndex - CONTEXT_RADIUS),
    Math.min(file.lines.length, endIndex + CONTEXT_RADIUS)
  ).filter((line) => line.number < section.start || line.number > section.end).map((line) => line.text).join("\n");
  const parentLabel = section.parentLabel ?? "";
  const content = selectedLines.map((line) => line.text).join("\n");
  const location = `${section.path}
${section.label}
${parentLabel}
${surrounding}`;
  const locationHash = hashText(location);
  return {
    id: `code-section-${locationHash.slice(0, 16)}`,
    kind: "code-section",
    path: section.path,
    label: section.label,
    range: { start: section.start, end: section.end },
    contentHash: hashText(content),
    locationHash
  };
}
function assertNoOverlaps(sections) {
  const byPath = /* @__PURE__ */ new Map();
  for (const section of sections) {
    const fileSections = byPath.get(section.path) ?? [];
    fileSections.push(section);
    byPath.set(section.path, fileSections);
  }
  for (const [path, pathSections] of byPath) {
    const sorted = [...pathSections].sort(
      (left, right) => left.start - right.start || left.end - right.end
    );
    for (let index = 1; index < sorted.length; index += 1) {
      if (sorted[index].start <= sorted[index - 1].end) {
        throw new Error(`overlapping code sections in ${path}`);
      }
    }
  }
}
function buildScopeSnapshot(input) {
  assertUniqueFiles(input.files);
  return {
    schemaVersion: 1,
    revisionId: input.revisionId,
    ...input.predecessorRevisionId === void 0 ? {} : { predecessorRevisionId: input.predecessorRevisionId },
    source: input.source,
    fingerprint: input.fingerprint,
    createdAt: input.createdAt,
    kind: "scope",
    files: input.files,
    items: []
  };
}
function applyCodeSections(snapshot, proposed) {
  assertNoOverlaps(proposed);
  const items = proposed.map((section) => validateAndBuildSection(snapshot, section));
  const duplicateItemId = findDuplicateReviewItemId(items);
  if (duplicateItemId) {
    throw new Error(
      `duplicate code-section identity ${duplicateItemId}; use a distinct label or parentLabel`
    );
  }
  return { ...snapshot, items };
}

// src/ids.ts
var SAFE_SEGMENT = /^[a-z0-9][a-z0-9._-]*$/;
function assertSafeReviewSegment(value, label) {
  if (!SAFE_SEGMENT.test(value)) {
    throw new Error(`invalid review ${label}`);
  }
}
function formatReviewRef(workspaceId, revisionId) {
  assertSafeReviewSegment(workspaceId, "workspace");
  assertSafeReviewSegment(revisionId, "revision");
  return `${workspaceId}@${revisionId}`;
}
function parseReviewRef(value) {
  const separator = value.lastIndexOf("@");
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error("review reference must be <workspace>@<revision>");
  }
  const workspaceId = value.slice(0, separator);
  const revisionId = value.slice(separator + 1);
  assertSafeReviewSegment(workspaceId, "workspace");
  assertSafeReviewSegment(revisionId, "revision");
  return { workspaceId, revisionId };
}

// src/paths.ts
import { lstatSync, realpathSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
function fileSystemErrorCode(error) {
  return typeof error === "object" && error !== null && "code" in error ? String(error.code) : void 0;
}
function canonicalProjectRoot(projectRoot) {
  try {
    return realpathSync.native(resolve(projectRoot));
  } catch {
    throw new ReviewCoreError("review_internal", "unable to resolve review project root");
  }
}
function assertReviewArtifactPath(projectRoot, artifactPath) {
  const root = canonicalProjectRoot(projectRoot);
  const target = resolve(artifactPath);
  const suffix = relative(root, target);
  if (suffix === ".." || suffix.startsWith(`..${sep}`) || resolve(root, suffix) !== target) {
    throw new ReviewCoreError("review_corrupt", "review artifact path escapes project root");
  }
  let current = root;
  for (const segment of suffix.split(sep).filter(Boolean)) {
    current = join(current, segment);
    try {
      if (lstatSync(current).isSymbolicLink()) {
        throw new ReviewCoreError(
          "review_corrupt",
          "review artifact path contains a symbolic link"
        );
      }
    } catch (error) {
      if (error instanceof ReviewCoreError) throw error;
      if (fileSystemErrorCode(error) === "ENOENT") break;
      throw new ReviewCoreError("review_internal", "unable to validate review artifact path");
    }
  }
  return target;
}
function reviewsDir(projectRoot) {
  return assertReviewArtifactPath(
    projectRoot,
    resolve(canonicalProjectRoot(projectRoot), ".synergy", "reviews")
  );
}
function reviewWorkspaceDir(projectRoot, workspaceId) {
  assertSafeReviewSegment(workspaceId, "workspace");
  return assertReviewArtifactPath(
    projectRoot,
    resolveReviewPath(reviewsDir(projectRoot), workspaceId)
  );
}
function reviewRevisionDir(projectRoot, workspaceId, revisionId) {
  assertSafeReviewSegment(revisionId, "revision");
  return assertReviewArtifactPath(
    projectRoot,
    resolveReviewPath(reviewWorkspaceDir(projectRoot, workspaceId), "revisions", revisionId)
  );
}
function resolveReviewPath(baseDir, ...segments) {
  const resolved = resolve(baseDir, ...segments);
  const base = baseDir.endsWith(sep) ? baseDir : `${baseDir}${sep}`;
  if (!resolved.startsWith(base)) {
    throw new Error("review artifact path escapes reviews directory");
  }
  return resolved;
}
function workspaceFile(projectRoot, workspaceId) {
  return assertReviewArtifactPath(
    projectRoot,
    join(reviewWorkspaceDir(projectRoot, workspaceId), "workspace.json")
  );
}
function snapshotFile(projectRoot, workspaceId, revisionId) {
  return assertReviewArtifactPath(
    projectRoot,
    join(reviewRevisionDir(projectRoot, workspaceId, revisionId), "snapshot.json")
  );
}
function insightsFile(projectRoot, workspaceId, revisionId) {
  return assertReviewArtifactPath(
    projectRoot,
    join(reviewRevisionDir(projectRoot, workspaceId, revisionId), "insights.json")
  );
}
function progressFile(projectRoot, workspaceId, revisionId) {
  return assertReviewArtifactPath(
    projectRoot,
    join(reviewRevisionDir(projectRoot, workspaceId, revisionId), "progress.json")
  );
}
function questionsDir(projectRoot, workspaceId, revisionId) {
  return assertReviewArtifactPath(
    projectRoot,
    join(reviewRevisionDir(projectRoot, workspaceId, revisionId), "questions")
  );
}
function answersDir(projectRoot, workspaceId, revisionId) {
  return assertReviewArtifactPath(
    projectRoot,
    join(reviewRevisionDir(projectRoot, workspaceId, revisionId), "answers")
  );
}

// src/schema.ts
import Ajv from "ajv";
var string = { type: "string" };
var nonEmptyString = { type: "string", minLength: 1 };
var timestamp = { type: "string", minLength: 1 };
var safeSegment = { type: "string", pattern: SAFE_SEGMENT.source };
var rangeSchema = {
  type: "object",
  required: ["start", "end"],
  additionalProperties: false,
  properties: { start: { type: "integer", minimum: 1 }, end: { type: "integer", minimum: 1 } }
};
var excludesSchema = { type: "array", items: nonEmptyString };
var sourceSchema = {
  oneOf: [
    {
      type: "object",
      required: ["kind", "number", "url", "baseSha", "headSha"],
      additionalProperties: false,
      properties: {
        kind: { const: "pr" },
        number: { type: "integer", minimum: 1 },
        url: nonEmptyString,
        baseSha: nonEmptyString,
        headSha: nonEmptyString,
        excludes: excludesSchema
      }
    },
    {
      type: "object",
      required: ["kind", "headSha"],
      additionalProperties: false,
      properties: {
        kind: { const: "staged" },
        headSha: nonEmptyString,
        excludes: excludesSchema
      }
    },
    {
      type: "object",
      required: ["kind", "headSha"],
      additionalProperties: false,
      properties: {
        kind: { const: "unstaged" },
        headSha: nonEmptyString,
        excludes: excludesSchema
      }
    },
    {
      type: "object",
      required: ["kind", "patterns", "headSha"],
      additionalProperties: false,
      properties: {
        kind: { const: "scope" },
        patterns: { type: "array", minItems: 1, items: nonEmptyString },
        headSha: nonEmptyString,
        excludes: excludesSchema
      }
    }
  ]
};
var itemSchema = {
  type: "object",
  required: ["id", "kind", "path", "label", "range", "contentHash", "locationHash"],
  additionalProperties: false,
  properties: {
    id: nonEmptyString,
    kind: { enum: ["hunk", "code-section", "file"] },
    path: nonEmptyString,
    label: nonEmptyString,
    range: rangeSchema,
    contentHash: nonEmptyString,
    locationHash: nonEmptyString
  }
};
var reviewWorkspaceSchema = {
  type: "object",
  required: [
    "schemaVersion",
    "id",
    "repository",
    "source",
    "currentRevisionId",
    "createdAt",
    "updatedAt"
  ],
  additionalProperties: false,
  properties: {
    schemaVersion: { const: 1 },
    id: nonEmptyString,
    repository: {
      type: "object",
      required: ["root", "name"],
      additionalProperties: false,
      properties: { root: nonEmptyString, name: nonEmptyString, remoteUrl: string }
    },
    source: sourceSchema,
    currentRevisionId: nonEmptyString,
    createdAt: timestamp,
    updatedAt: timestamp
  }
};
var diffLineSchema = {
  type: "object",
  required: ["kind", "text", "oldLine", "newLine"],
  additionalProperties: false,
  properties: {
    kind: { enum: ["context", "add", "remove"] },
    text: string,
    oldLine: { type: ["integer", "null"], minimum: 1 },
    newLine: { type: ["integer", "null"], minimum: 1 },
    noNewlineAtEnd: { type: "boolean" }
  }
};
var diffHunkSchema = {
  type: "object",
  required: [
    "reviewItemId",
    "reviewItemContentHash",
    "reviewItemLocationHash",
    "header",
    "oldStart",
    "oldLines",
    "newStart",
    "newLines",
    "lines"
  ],
  additionalProperties: false,
  properties: {
    reviewItemId: nonEmptyString,
    reviewItemContentHash: nonEmptyString,
    reviewItemLocationHash: nonEmptyString,
    header: nonEmptyString,
    oldStart: { type: "integer", minimum: 0 },
    oldLines: { type: "integer", minimum: 0 },
    newStart: { type: "integer", minimum: 0 },
    newLines: { type: "integer", minimum: 0 },
    lines: { type: "array", items: diffLineSchema }
  }
};
var diffFileSchema = {
  type: "object",
  required: ["path", "status", "additions", "deletions", "binary", "hunks"],
  additionalProperties: false,
  properties: {
    reviewItemId: nonEmptyString,
    reviewItemContentHash: nonEmptyString,
    reviewItemLocationHash: nonEmptyString,
    path: nonEmptyString,
    previousPath: nonEmptyString,
    oldMode: nonEmptyString,
    newMode: nonEmptyString,
    binaryPatchHash: nonEmptyString,
    status: { enum: ["added", "deleted", "modified", "renamed", "copied", "binary"] },
    additions: { type: "integer", minimum: 0 },
    deletions: { type: "integer", minimum: 0 },
    binary: { type: "boolean" },
    hunks: { type: "array", items: diffHunkSchema }
  }
};
var sourceFileSchema = {
  type: "object",
  required: ["path", "lines", "binary"],
  additionalProperties: false,
  properties: {
    path: nonEmptyString,
    binary: { type: "boolean" },
    lines: {
      type: "array",
      items: {
        type: "object",
        required: ["number", "text"],
        additionalProperties: false,
        properties: { number: { type: "integer", minimum: 1 }, text: string }
      }
    }
  }
};
var scopeLineRowSchema = {
  type: "object",
  required: ["id", "kind", "line", "text"],
  additionalProperties: false,
  properties: {
    id: nonEmptyString,
    kind: { const: "scope" },
    line: { type: "integer", minimum: 1 },
    text: string
  }
};
var diffLineRowSchema = {
  type: "object",
  required: ["id", "kind", "oldLine", "newLine", "text"],
  additionalProperties: false,
  properties: {
    id: nonEmptyString,
    kind: { enum: ["context", "add", "remove"] },
    oldLine: { type: ["integer", "null"], minimum: 1 },
    newLine: { type: ["integer", "null"], minimum: 1 },
    text: string,
    noNewlineAtEnd: { type: "boolean" }
  }
};
var itemContextSchema = {
  type: "object",
  required: ["item", "rows"],
  additionalProperties: false,
  properties: {
    item: itemSchema,
    rows: { type: "array", minItems: 1, items: { oneOf: [scopeLineRowSchema, diffLineRowSchema] } }
  }
};
var lineSelectionSchema = {
  oneOf: [
    {
      type: "object",
      required: ["kind", "selectedLineIds"],
      additionalProperties: false,
      properties: {
        kind: { const: "diff" },
        selectedLineIds: { type: "array", minItems: 1, uniqueItems: true, items: nonEmptyString }
      }
    },
    {
      type: "object",
      required: ["kind", "selectedLineIds"],
      additionalProperties: false,
      properties: {
        kind: { const: "scope" },
        selectedLineIds: { type: "array", minItems: 1, uniqueItems: true, items: nonEmptyString }
      }
    }
  ]
};
var snapshotBaseProperties = {
  schemaVersion: { const: 1 },
  revisionId: nonEmptyString,
  predecessorRevisionId: safeSegment,
  source: sourceSchema,
  fingerprint: nonEmptyString,
  createdAt: timestamp,
  items: { type: "array", items: itemSchema }
};
var reviewSnapshotSchema = {
  oneOf: [
    {
      type: "object",
      required: [
        "schemaVersion",
        "revisionId",
        "source",
        "fingerprint",
        "createdAt",
        "items",
        "kind",
        "files"
      ],
      additionalProperties: false,
      properties: {
        ...snapshotBaseProperties,
        kind: { const: "diff" },
        files: { type: "array", items: diffFileSchema }
      }
    },
    {
      type: "object",
      required: [
        "schemaVersion",
        "revisionId",
        "source",
        "fingerprint",
        "createdAt",
        "items",
        "kind",
        "files"
      ],
      additionalProperties: false,
      properties: {
        ...snapshotBaseProperties,
        kind: { const: "scope" },
        files: { type: "array", items: sourceFileSchema }
      }
    }
  ]
};
var fileInsightSchema = {
  type: "object",
  required: ["path", "description", "confidence"],
  additionalProperties: false,
  properties: {
    path: nonEmptyString,
    description: nonEmptyString,
    confidence: { enum: ["high", "medium", "low"] }
  }
};
var removalRunRefSchema = {
  type: "object",
  required: ["path", "start", "end"],
  additionalProperties: false,
  properties: {
    path: nonEmptyString,
    start: { type: "integer", minimum: 1 },
    end: { type: "integer", minimum: 1 }
  }
};
var removalRationaleSchema = {
  type: "object",
  required: ["reviewItemId", "run", "reason", "description"],
  additionalProperties: false,
  properties: {
    reviewItemId: nonEmptyString,
    run: removalRunRefSchema,
    reason: {
      enum: ["moved", "merged", "replaced", "dead-code", "obsolete", "extracted-to-dep", "unclear"]
    },
    description: nonEmptyString,
    movedTo: removalRunRefSchema,
    movedToExcerpt: {
      type: "object",
      required: ["path", "start", "lines"],
      additionalProperties: false,
      properties: {
        path: nonEmptyString,
        start: { type: "integer", minimum: 1 },
        lines: { type: "array", items: string }
      }
    }
  }
};
var reviewInsightsSchema = {
  type: "object",
  required: ["schemaVersion", "revisionId", "groups", "items"],
  additionalProperties: false,
  properties: {
    schemaVersion: { const: 1 },
    revisionId: nonEmptyString,
    summary: nonEmptyString,
    groups: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "label", "reviewItemIds"],
        additionalProperties: false,
        properties: {
          id: nonEmptyString,
          label: nonEmptyString,
          intro: nonEmptyString,
          reviewItemIds: { type: "array", items: nonEmptyString }
        }
      }
    },
    items: {
      type: "array",
      items: {
        type: "object",
        required: ["reviewItemId", "description", "confidence", "evidencePaths"],
        additionalProperties: false,
        properties: {
          reviewItemId: nonEmptyString,
          description: nonEmptyString,
          confidence: { enum: ["high", "medium", "low"] },
          evidencePaths: { type: "array", items: nonEmptyString }
        }
      }
    },
    files: { type: "array", items: fileInsightSchema },
    removals: { type: "array", items: removalRationaleSchema }
  }
};
var itemProgressSchema = {
  type: "object",
  required: ["status"],
  additionalProperties: false,
  properties: {
    status: { enum: ["needs-review", "reviewed", "carried-forward", "stale"] },
    note: string,
    reviewedAt: timestamp,
    inheritedFrom: {
      type: "object",
      required: ["revisionId", "reviewItemId"],
      additionalProperties: false,
      properties: { revisionId: nonEmptyString, reviewItemId: nonEmptyString }
    }
  }
};
var reviewProgressSchema = {
  type: "object",
  required: ["schemaVersion", "updatedAt", "items"],
  additionalProperties: false,
  properties: {
    schemaVersion: { const: 1 },
    updatedAt: timestamp,
    items: { type: "object", additionalProperties: itemProgressSchema },
    activeGroupId: nonEmptyString,
    activeFile: nonEmptyString,
    activeReviewItemId: nonEmptyString
  }
};
var claimSchema = {
  type: "object",
  required: ["listenerId", "token", "claimedAt", "expiresAt"],
  additionalProperties: false,
  properties: {
    listenerId: nonEmptyString,
    token: safeSegment,
    claimedAt: timestamp,
    expiresAt: timestamp
  }
};
var questionEnvelopeProperties = {
  schemaVersion: { const: 1 },
  id: nonEmptyString,
  workspaceId: nonEmptyString,
  revisionId: nonEmptyString,
  path: nonEmptyString,
  reviewItemId: nonEmptyString,
  selection: lineSelectionSchema,
  itemContext: itemContextSchema,
  description: string,
  body: nonEmptyString,
  createdAt: timestamp
};
var reviewQuestionEnvelopeSchema = {
  type: "object",
  required: [
    "schemaVersion",
    "id",
    "workspaceId",
    "revisionId",
    "path",
    "reviewItemId",
    "selection",
    "itemContext",
    "description",
    "body",
    "createdAt"
  ],
  additionalProperties: false,
  properties: questionEnvelopeProperties
};
var reviewQuestionSchema = {
  type: "object",
  required: [
    "schemaVersion",
    "id",
    "workspaceId",
    "revisionId",
    "path",
    "reviewItemId",
    "selection",
    "itemContext",
    "description",
    "body",
    "createdAt",
    "generation",
    "status"
  ],
  additionalProperties: false,
  properties: {
    schemaVersion: { const: 1 },
    id: nonEmptyString,
    workspaceId: nonEmptyString,
    revisionId: nonEmptyString,
    path: nonEmptyString,
    reviewItemId: nonEmptyString,
    selection: lineSelectionSchema,
    itemContext: itemContextSchema,
    description: string,
    body: nonEmptyString,
    createdAt: timestamp,
    generation: { type: "integer", minimum: 0 },
    status: { enum: ["queued", "processing", "answered", "failed", "stale"] },
    claim: claimSchema,
    failureMessage: string
  }
};
var reviewQuestionGenerationSchema = {
  type: "object",
  required: [
    "schemaVersion",
    "questionId",
    "workspaceId",
    "revisionId",
    "generation",
    "predecessorGeneration",
    "predecessorHash",
    "envelopeHash",
    "state",
    "publishedAt"
  ],
  additionalProperties: false,
  properties: {
    schemaVersion: { const: 1 },
    questionId: nonEmptyString,
    workspaceId: nonEmptyString,
    revisionId: nonEmptyString,
    generation: { type: "integer", minimum: 0 },
    predecessorGeneration: { type: ["integer", "null"], minimum: 0 },
    predecessorHash: { type: ["string", "null"], minLength: 1 },
    envelopeHash: nonEmptyString,
    state: { enum: ["queued", "claimed", "answer-pending", "answered", "failed", "stale"] },
    publishedAt: timestamp,
    claim: claimSchema,
    answer: {
      type: "object",
      required: ["id", "listenerId", "bodyHash", "createdAt"],
      additionalProperties: false,
      properties: {
        id: safeSegment,
        listenerId: nonEmptyString,
        bodyHash: nonEmptyString,
        createdAt: timestamp
      }
    },
    failureMessage: nonEmptyString
  }
};
var reviewAnswerSchema = {
  type: "object",
  required: [
    "schemaVersion",
    "id",
    "questionId",
    "workspaceId",
    "revisionId",
    "listenerId",
    "body",
    "createdAt"
  ],
  additionalProperties: false,
  properties: {
    schemaVersion: { const: 1 },
    id: nonEmptyString,
    questionId: nonEmptyString,
    workspaceId: nonEmptyString,
    revisionId: nonEmptyString,
    listenerId: nonEmptyString,
    body: nonEmptyString,
    createdAt: timestamp
  }
};
var ajv = new Ajv({ allErrors: true, strict: false });
var validators = {
  workspace: ajv.compile(reviewWorkspaceSchema),
  snapshot: ajv.compile(reviewSnapshotSchema),
  insights: ajv.compile(reviewInsightsSchema),
  progress: ajv.compile(reviewProgressSchema),
  question: ajv.compile(reviewQuestionSchema),
  questionEnvelope: ajv.compile(reviewQuestionEnvelopeSchema),
  questionGeneration: ajv.compile(reviewQuestionGenerationSchema),
  answer: ajv.compile(reviewAnswerSchema)
};
function assertSchema(value, validate, artifact) {
  if (validate(value)) return;
  const details = (validate.errors ?? []).map((error) => `${error.instancePath || "(root)"} ${error.message ?? "invalid"}`).join("; ");
  throw new Error(`invalid review ${artifact}: ${details}`);
}
function assertReviewRange(range) {
  if (range.start > range.end) {
    throw new Error("review range start must not exceed end");
  }
}
function assertReviewWorkspace(value) {
  assertSchema(value, validators.workspace, "workspace");
}
function assertReviewSnapshot(value) {
  assertSchema(value, validators.snapshot, "snapshot");
  const duplicateItemId = findDuplicateReviewItemId(value.items);
  if (duplicateItemId) throw new Error(`duplicate review item id: ${duplicateItemId}`);
  if (value.kind === "diff" && value.files.some((file) => file.binary && !file.binaryPatchHash)) {
    throw new Error("binary diff file must retain its canonical patch hash");
  }
  for (const item of value.items) {
    assertReviewRange(item.range);
  }
}
function assertReviewInsights(value) {
  assertSchema(value, validators.insights, "insights");
}
function assertReviewProgress(value) {
  assertSchema(value, validators.progress, "progress");
}
function assertReviewQuestion(value) {
  assertSchema(value, validators.question, "question");
}
function assertReviewQuestionEnvelope(value) {
  assertSchema(value, validators.questionEnvelope, "question envelope");
}
function assertReviewQuestionGeneration(value) {
  assertSchema(
    value,
    validators.questionGeneration,
    "question generation"
  );
  if (value.generation === 0) {
    if (value.predecessorGeneration !== null || value.predecessorHash !== null) {
      throw new Error("initial review question generation must not have a predecessor");
    }
  } else if (value.predecessorGeneration !== value.generation - 1 || value.predecessorHash === null) {
    throw new Error("review question generation must reference its immediate predecessor");
  }
  const needsClaim = value.state === "claimed" || value.state === "answer-pending";
  if (needsClaim !== (value.claim !== void 0)) {
    throw new Error(`review question generation state ${value.state} has invalid claim data`);
  }
  const needsAnswer = value.state === "answer-pending" || value.state === "answered";
  if (needsAnswer !== (value.answer !== void 0)) {
    throw new Error(`review question generation state ${value.state} has invalid answer data`);
  }
  if (value.state === "answer-pending" && value.answer?.listenerId !== value.claim?.listenerId) {
    throw new Error("review question pending answer owner does not match its claim");
  }
  if (value.state === "answer-pending" && value.answer?.id !== `answer-${value.questionId}-${value.claim?.token}`) {
    throw new Error("review question generation answer id is not token-scoped deterministic");
  }
  const needsFailure = value.state === "failed";
  if (needsFailure !== (value.failureMessage !== void 0)) {
    throw new Error(`review question generation state ${value.state} has invalid failure data`);
  }
  if (value.claim) assertSafeReviewSegment(value.claim.token, "claim token");
  if (value.answer) assertSafeReviewSegment(value.answer.id, "answer");
}
function assertReviewAnswer(value) {
  assertSchema(value, validators.answer, "answer");
  assertSafeReviewSegment(value.id, "answer");
}

// src/types.ts
var RELOCATING_REMOVAL_REASONS = ["moved", "merged", "replaced"];

// src/store.ts
import { randomUUID as randomUUID3 } from "node:crypto";
import {
  closeSync as closeSync2,
  existsSync as existsSync6,
  fstatSync,
  fsyncSync as fsyncSync2,
  lstatSync as lstatSync2,
  mkdirSync as mkdirSync3,
  openSync as openSync2,
  readFileSync as readFileSync4,
  readdirSync as readdirSync3,
  renameSync as renameSync2,
  rmSync as rmSync3,
  unlinkSync,
  writeFileSync as writeFileSync3
} from "node:fs";
import { basename as basename2, dirname as dirname3, join as join6 } from "node:path";

// src/questions.ts
import { existsSync as existsSync5, mkdirSync as mkdirSync2, rmSync as rmSync2 } from "node:fs";
import { dirname as dirname2, join as join5 } from "node:path";

// src/question-answer.ts
import { existsSync as existsSync3 } from "node:fs";

// src/durable-publication.ts
import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync as writeFileSync2
} from "node:fs";
import { basename, dirname, join as join2 } from "node:path";
var CommittedPublicationError = class extends Error {
  destination;
  expectedBytes;
  constructor(destination, expectedBytes, cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`review artifact was linked but directory fsync failed for ${destination}: ${detail}`);
    this.name = "CommittedPublicationError";
    this.destination = destination;
    this.expectedBytes = expectedBytes;
  }
};
function errorCode(error) {
  return typeof error === "object" && error !== null && "code" in error ? String(error.code) : void 0;
}
function serializeJson(value) {
  return `${JSON.stringify(value, null, 2)}
`;
}
function isExactCommittedPublication(error) {
  if (!(error instanceof CommittedPublicationError)) return false;
  try {
    return readFileSync(error.destination, "utf8") === error.expectedBytes;
  } catch {
    return false;
  }
}
function fsyncDirectory(directory, before, after) {
  let descriptor;
  try {
    descriptor = openSync(directory, "r");
    before?.();
    fsyncSync(descriptor);
    after?.();
  } finally {
    if (descriptor !== void 0) closeSync(descriptor);
  }
}
function ensureDurableDirectory(directory, publication, options) {
  mkdirSync(directory, { recursive: true });
  fsyncDirectory(
    dirname(directory),
    () => options.beforeParentDirectoryFsync?.(publication),
    () => options.afterParentDirectoryFsync?.(publication)
  );
}
function publishExclusiveText(path, raw, publication, options, authorize, validatePath) {
  const directory = dirname(path);
  ensureDurableDirectory(directory, publication, options);
  validatePath?.();
  const temporary = join2(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  let fileDescriptor;
  try {
    fileDescriptor = openSync(temporary, "wx");
    writeFileSync2(fileDescriptor, raw, "utf8");
    options.beforeFileFsync?.(publication);
    fsyncSync(fileDescriptor);
    options.afterFileFsync?.(publication);
    closeSync(fileDescriptor);
    fileDescriptor = void 0;
    options.beforePublish?.(publication);
    authorize?.();
    validatePath?.();
    try {
      if (options.link) options.link(temporary, path, publication);
      else linkSync(temporary, path);
    } catch (error) {
      const code = errorCode(error);
      if (code === "ENOTSUP" || code === "EOPNOTSUPP" || code === "EXDEV") {
        throw new Error(`hard-link publication is unsupported for review artifact ${path}`);
      }
      throw error;
    }
    try {
      fsyncDirectory(
        directory,
        () => options.beforeDirectoryFsync?.(publication),
        () => options.afterDirectoryFsync?.(publication)
      );
    } catch (error) {
      throw new CommittedPublicationError(path, raw, error);
    }
    options.afterPublish?.(publication);
  } finally {
    if (fileDescriptor !== void 0) closeSync(fileDescriptor);
    try {
      if (options.cleanupTemporary) options.cleanupTemporary(temporary, publication);
      else rmSync(temporary, { force: true });
    } catch (cleanupError) {
    }
  }
}

// src/question-chain.ts
import { existsSync, readFileSync as readFileSync2, readdirSync } from "node:fs";
import { join as join3 } from "node:path";
var GENERATION_NAME = /^(\d{12})\.json$/;
function questionDirectory(projectRoot, reference) {
  return questionsDir(projectRoot, reference.workspaceId, reference.revisionId);
}
function questionFile(projectRoot, reference, questionId) {
  assertSafeReviewSegment(questionId, "question");
  return assertReviewArtifactPath(
    projectRoot,
    join3(questionDirectory(projectRoot, reference), `${questionId}.json`)
  );
}
function generationsDirectory(projectRoot, reference, questionId) {
  assertSafeReviewSegment(questionId, "question");
  return assertReviewArtifactPath(
    projectRoot,
    join3(questionDirectory(projectRoot, reference), `${questionId}.generations`)
  );
}
function generationFile(projectRoot, reference, questionId, generation) {
  return assertReviewArtifactPath(
    projectRoot,
    join3(
      generationsDirectory(projectRoot, reference, questionId),
      `${generation.toString().padStart(12, "0")}.json`
    )
  );
}
function readUnknownArtifact(path) {
  let raw;
  try {
    raw = readFileSync2(path, "utf8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`unable to read review artifact ${path}: ${detail}`);
  }
  try {
    return { raw, value: JSON.parse(raw) };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`invalid JSON in review artifact ${path}: ${detail}`);
  }
}
function readEnvelopeArtifact(path) {
  const artifact = readUnknownArtifact(path);
  const envelope = artifact.value;
  assertReviewQuestionEnvelope(envelope);
  return { raw: artifact.raw, value: envelope };
}
function validateQuestionRelationship(envelope, reference, snapshot) {
  if (envelope.workspaceId !== reference.workspaceId || envelope.revisionId !== reference.revisionId) {
    throw new Error("review question identity does not match requested bundle");
  }
  const item = snapshot.items.find((candidate) => candidate.id === envelope.reviewItemId);
  if (!item) throw new Error("review question references an unknown review item");
  if (item.path !== envelope.path) {
    throw new Error("review question path does not match its review item");
  }
  const canonicalContext = resolveReviewItemContext(snapshot, item.id);
  if (JSON.stringify(envelope.itemContext) !== JSON.stringify(canonicalContext)) {
    throw new Error("review question item context does not match its immutable review item");
  }
  const canonicalSelection = resolveReviewLineSelection(
    snapshot,
    item.id,
    envelope.selection.selectedLineIds
  );
  if (envelope.selection.kind !== canonicalSelection.kind || envelope.selection.selectedLineIds.some(
    (lineId, index) => lineId !== canonicalSelection.selectedLineIds[index]
  )) {
    throw new Error("review question selection does not match its immutable review item");
  }
}
function sameClaim(left, right) {
  return left?.listenerId === right?.listenerId && left?.token === right?.token && left?.claimedAt === right?.claimedAt && left?.expiresAt === right?.expiresAt;
}
function sameClaimIdentity(left, right) {
  return left?.listenerId === right?.listenerId && left?.token === right?.token && left?.claimedAt === right?.claimedAt;
}
function sameAnswer(left, right) {
  return left?.id === right?.id && left?.listenerId === right?.listenerId && left?.bodyHash === right?.bodyHash && left?.createdAt === right?.createdAt;
}
function assertLegalTransition(previous, current) {
  if (current.envelopeHash !== previous.envelopeHash) {
    throw new Error("review question generation changed its immutable envelope hash");
  }
  if (Date.parse(current.publishedAt) < Date.parse(previous.publishedAt)) {
    throw new Error("review question generation publication time moved backwards");
  }
  if (previous.state === "queued") {
    if (current.state !== "claimed") {
      throw new Error(`illegal review question transition queued -> ${current.state}`);
    }
    return;
  }
  if (previous.state === "claimed") {
    if (current.state === "queued") return;
    if (current.state === "failed") return;
    if (current.state === "answer-pending") {
      if (!sameClaim(previous.claim, current.claim)) {
        throw new Error("review question answer-pending transition changed claim identity");
      }
      return;
    }
    if (current.state === "claimed") {
      if (previous.claim?.token === current.claim?.token) {
        if (!sameClaimIdentity(previous.claim, current.claim)) {
          throw new Error("review question renew changed claim identity carry-forward fields");
        }
        return;
      }
      if (Date.parse(previous.claim?.expiresAt ?? "") <= Date.parse(current.publishedAt) && current.claim?.claimedAt === current.publishedAt) {
        return;
      }
    }
    throw new Error(`illegal review question transition claimed -> ${current.state}`);
  }
  if (previous.state === "answer-pending") {
    if (current.state === "answered") {
      if (!sameAnswer(previous.answer, current.answer)) {
        throw new Error("review question answered transition changed answer carry-forward fields");
      }
      return;
    }
    if (current.state === "queued" && Date.parse(previous.claim?.expiresAt ?? "") <= Date.parse(current.publishedAt)) {
      return;
    }
    if (current.state === "failed") return;
    throw new Error(`illegal review question transition answer-pending -> ${current.state}`);
  }
  if (previous.state === "failed") {
    if (current.state === "claimed" && current.claim?.claimedAt === current.publishedAt) return;
    throw new Error(`illegal review question transition failed -> ${current.state}`);
  }
  throw new Error(`illegal review question transition from terminal state ${previous.state}`);
}
function readGenerationChain(projectRoot, reference, questionId) {
  const directory = generationsDirectory(projectRoot, reference, questionId);
  if (!existsSync(directory)) {
    throw new Error(`review question ${questionId} is missing its generation log`);
  }
  const files = readdirSync(directory).filter((entry) => GENERATION_NAME.test(entry)).sort();
  if (files.length === 0) {
    throw new Error(`review question ${questionId} is missing generation 0`);
  }
  let previousRaw;
  let previous;
  for (let index = 0; index < files.length; index += 1) {
    const expected = `${index.toString().padStart(12, "0")}.json`;
    const file = files[index];
    if (file !== expected) {
      throw new Error(`review question ${questionId} generation chain must be contiguous`);
    }
    const artifact = readUnknownArtifact(join3(directory, file));
    assertReviewQuestionGeneration(artifact.value);
    const generation = artifact.value;
    if (generation.questionId !== questionId || generation.workspaceId !== reference.workspaceId || generation.revisionId !== reference.revisionId || generation.generation !== index) {
      throw new Error(`review question ${questionId} generation identity is corrupt`);
    }
    if (index === 0) {
      if (generation.state !== "queued") {
        throw new Error(`review question ${questionId} initial generation must be queued`);
      }
    } else {
      if (generation.predecessorHash !== hashText(previousRaw ?? "")) {
        throw new Error(`review question ${questionId} generation predecessor hash is invalid`);
      }
      if (!previous) throw new Error(`review question ${questionId} predecessor is incomplete`);
      assertLegalTransition(previous, generation);
    }
    previousRaw = artifact.raw;
    previous = generation;
  }
  if (!previous || previousRaw === void 0) {
    throw new Error(`review question ${questionId} has an incomplete generation chain`);
  }
  return { current: previous, currentHash: hashText(previousRaw) };
}
function loadQuestionState(projectRoot, reference, snapshot, questionId) {
  const path = questionFile(projectRoot, reference, questionId);
  if (!existsSync(path)) throw new Error("review question does not exist");
  const envelopeArtifact = readEnvelopeArtifact(path);
  if (envelopeArtifact.value.id !== questionId) {
    throw new Error("review question file identity is corrupt");
  }
  validateQuestionRelationship(envelopeArtifact.value, reference, snapshot);
  const chain = readGenerationChain(projectRoot, reference, questionId);
  if (chain.current.envelopeHash !== hashText(envelopeArtifact.raw)) {
    throw new Error("review question envelope does not match its generation authority");
  }
  return { envelope: envelopeArtifact.value, chain };
}
function hydrateQuestion(envelope, generation) {
  const status = generation.state === "claimed" || generation.state === "answer-pending" ? "processing" : generation.state;
  return {
    ...envelope,
    generation: generation.generation,
    status,
    ...generation.claim ? { claim: generation.claim } : {},
    ...generation.failureMessage ? { failureMessage: generation.failureMessage } : {}
  };
}
function nextGeneration(state, nextState, now, fields = {}) {
  return {
    schemaVersion: 1,
    questionId: state.envelope.id,
    workspaceId: state.envelope.workspaceId,
    revisionId: state.envelope.revisionId,
    generation: state.chain.current.generation + 1,
    predecessorGeneration: state.chain.current.generation,
    predecessorHash: state.chain.currentHash,
    envelopeHash: state.chain.current.envelopeHash,
    state: nextState,
    publishedAt: new Date(now).toISOString(),
    ...fields
  };
}
function tryPublishGeneration(projectRoot, reference, generation, options) {
  assertReviewQuestionGeneration(generation);
  const path = generationFile(projectRoot, reference, generation.questionId, generation.generation);
  const raw = serializeJson(generation);
  try {
    publishExclusiveText(
      path,
      raw,
      {
        kind: "generation",
        path,
        questionId: generation.questionId,
        generation: generation.generation,
        state: generation.state
      },
      options,
      void 0,
      () => assertReviewArtifactPath(projectRoot, path)
    );
    return true;
  } catch (error) {
    if (isExactCommittedPublication(error)) return true;
    if (errorCode(error) === "EEXIST") return false;
    throw error;
  }
}

// src/question-generations.ts
import { existsSync as existsSync2, readFileSync as readFileSync3, readdirSync as readdirSync2 } from "node:fs";
import { join as join4 } from "node:path";
function readArtifact(path) {
  let raw;
  try {
    raw = readFileSync3(path, "utf8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`unable to read review artifact ${path}: ${detail}`);
  }
  try {
    return { raw, value: JSON.parse(raw) };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`invalid JSON in review artifact ${path}: ${detail}`);
  }
}
function answerFile(projectRoot, reference, id) {
  assertSafeReviewSegment(id, "answer");
  return assertReviewArtifactPath(
    projectRoot,
    join4(answersDir(projectRoot, reference.workspaceId, reference.revisionId), `${id}.json`)
  );
}
function answerId(questionId, claimToken) {
  assertSafeReviewSegment(questionId, "question");
  assertSafeReviewSegment(claimToken, "claim token");
  const id = `answer-${questionId}-${claimToken}`;
  assertSafeReviewSegment(id, "answer");
  return id;
}
function readAuthoritativeSnapshot(projectRoot, reference) {
  const workspaceArtifact = readArtifact(workspaceFile(projectRoot, reference.workspaceId));
  assertReviewWorkspace(workspaceArtifact.value);
  if (workspaceArtifact.value.id !== reference.workspaceId) {
    throw new Error("review workspace id does not match requested workspace");
  }
  const bundlePath = assertReviewArtifactPath(
    projectRoot,
    join4(
      reviewRevisionDir(projectRoot, reference.workspaceId, reference.revisionId),
      "bundle.json"
    )
  );
  let snapshot;
  if (existsSync2(bundlePath)) {
    const bundle = readArtifact(bundlePath).value;
    if (typeof bundle !== "object" || bundle === null || !("schemaVersion" in bundle) || bundle.schemaVersion !== 1 || !("finalized" in bundle) || bundle.finalized !== true || !("snapshot" in bundle) || !("insights" in bundle) || !("progress" in bundle)) {
      throw new Error(`invalid finalized review bundle ${bundlePath}`);
    }
    assertReviewSnapshot(bundle.snapshot);
    assertReviewInsights(bundle.insights);
    assertReviewProgress(bundle.progress);
    snapshot = bundle.snapshot;
  } else {
    const snapshotArtifact = readArtifact(
      snapshotFile(projectRoot, reference.workspaceId, reference.revisionId)
    );
    assertReviewSnapshot(snapshotArtifact.value);
    snapshot = snapshotArtifact.value;
  }
  if (snapshot.revisionId !== reference.revisionId) {
    throw new Error("review snapshot revision does not match requested revision");
  }
  return snapshot;
}
function expectedAnswer(reference, questionId, answerReference, body) {
  return {
    schemaVersion: 1,
    id: answerReference.id,
    questionId,
    workspaceId: reference.workspaceId,
    revisionId: reference.revisionId,
    listenerId: answerReference.listenerId,
    body,
    createdAt: answerReference.createdAt
  };
}
function readPendingAnswer(projectRoot, reference, questionId, answerReference) {
  const path = answerFile(projectRoot, reference, answerReference.id);
  if (!existsSync2(path)) return void 0;
  const artifact = readArtifact(path);
  assertReviewAnswer(artifact.value);
  const answer = artifact.value;
  const expected = expectedAnswer(reference, questionId, answerReference, answer.body);
  if (hashText(answer.body) !== answerReference.bodyHash || serializeJson(expected) !== artifact.raw) {
    throw new Error(`review answer ${answer.id} does not match pending answer bytes`);
  }
  return answer;
}
function readQuestionArtifacts(projectRoot, reference, snapshot = readAuthoritativeSnapshot(projectRoot, reference)) {
  const directory = questionDirectory(projectRoot, reference);
  if (!existsSync2(directory)) return { questions: [], answers: [] };
  const questions = [];
  const answers = [];
  for (const entry of readdirSync2(directory).filter((name) => name.endsWith(".json")).sort()) {
    const questionId = entry.slice(0, -".json".length);
    const state = loadQuestionState(projectRoot, reference, snapshot, questionId);
    questions.push(hydrateQuestion(state.envelope, state.chain.current));
    const answerReference = state.chain.current.answer;
    if (answerReference) {
      const answer = readPendingAnswer(projectRoot, reference, questionId, answerReference);
      if (state.chain.current.state === "answered" && !answer) {
        throw new Error(`answered review question ${questionId} is missing its immutable answer`);
      }
      if (answer) answers.push(answer);
    }
  }
  return { questions, answers: answers.sort((left, right) => left.id.localeCompare(right.id)) };
}

// src/question-transitions.ts
import { randomUUID as randomUUID2 } from "node:crypto";
function isActiveClaim(generation, listenerId, claimToken, now) {
  return generation.claim?.listenerId === listenerId && generation.claim.token === claimToken && Date.parse(generation.claim.expiresAt) > now;
}
function assertClaimParameters(now, leaseMs) {
  if (!Number.isFinite(now) || !Number.isFinite(leaseMs) || leaseMs <= 0) {
    throw new Error("review question claim requires a positive lease duration");
  }
}
function createClaim(listenerId, now, leaseMs) {
  const token = randomUUID2();
  assertSafeReviewSegment(token, "claim token");
  return {
    listenerId,
    token,
    claimedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + leaseMs).toISOString()
  };
}
function reconcilePending(projectRoot, reference, state, now, options) {
  const answerReference = state.chain.current.answer;
  if (!answerReference) {
    throw new Error("answer-pending generation is missing its answer reference");
  }
  const answer = readPendingAnswer(projectRoot, reference, state.envelope.id, answerReference);
  const generation = answer ? nextGeneration(state, "answered", now, { answer: answerReference }) : nextGeneration(state, "queued", now);
  if (!tryPublishGeneration(projectRoot, reference, generation, options)) return "retry";
  return answer ? "answered" : "retry";
}
function claimQuestionWithOptions(projectRoot, reference, questionId, listenerId, now, leaseMs, options) {
  assertClaimParameters(now, leaseMs);
  assertSafeReviewSegment(questionId, "question");
  assertSafeReviewSegment(listenerId, "listener");
  const snapshot = readAuthoritativeSnapshot(projectRoot, reference);
  while (true) {
    const state = loadQuestionState(projectRoot, reference, snapshot, questionId);
    const current = state.chain.current;
    if (current.state === "answered" || current.state === "stale") return { ok: false };
    if (current.state === "answer-pending") {
      if (Date.parse(current.claim?.expiresAt ?? "") > now) return { ok: false };
      const reconciled = reconcilePending(projectRoot, reference, state, now, options);
      if (reconciled === "answered") return { ok: false };
      continue;
    }
    if (current.state === "claimed" && Date.parse(current.claim?.expiresAt ?? "") > now) {
      return { ok: false };
    }
    const claim = createClaim(listenerId, now, leaseMs);
    const generation = nextGeneration(state, "claimed", now, { claim });
    if (tryPublishGeneration(projectRoot, reference, generation, options)) {
      return { ok: true, question: hydrateQuestion(state.envelope, generation) };
    }
  }
}
function renewClaimWithOptions(projectRoot, reference, questionId, listenerId, claimToken, now, leaseMs, options) {
  assertClaimParameters(now, leaseMs);
  const snapshot = readAuthoritativeSnapshot(projectRoot, reference);
  while (true) {
    const state = loadQuestionState(projectRoot, reference, snapshot, questionId);
    const current = state.chain.current;
    if (current.state !== "claimed" || !current.claim || !isActiveClaim(current, listenerId, claimToken, now)) {
      return { ok: false };
    }
    const claim = {
      ...current.claim,
      expiresAt: new Date(now + leaseMs).toISOString()
    };
    const generation = nextGeneration(state, "claimed", now, { claim });
    if (tryPublishGeneration(projectRoot, reference, generation, options)) {
      return { ok: true, question: hydrateQuestion(state.envelope, generation) };
    }
  }
}
function releaseClaimWithOptions(projectRoot, reference, questionId, listenerId, claimToken, now, options) {
  const snapshot = readAuthoritativeSnapshot(projectRoot, reference);
  while (true) {
    const state = loadQuestionState(projectRoot, reference, snapshot, questionId);
    const current = state.chain.current;
    if (current.state !== "claimed" || !isActiveClaim(current, listenerId, claimToken, now)) {
      return false;
    }
    if (tryPublishGeneration(projectRoot, reference, nextGeneration(state, "queued", now), options)) {
      return true;
    }
  }
}
function failQuestionWithOptions(projectRoot, reference, questionId, listenerId, claimToken, failureMessage, now, options) {
  if (failureMessage.trim().length === 0) {
    throw new Error("review question failure message must not be empty");
  }
  assertSafeReviewSegment(questionId, "question");
  assertSafeReviewSegment(listenerId, "listener");
  assertSafeReviewSegment(claimToken, "claim token");
  const snapshot = readAuthoritativeSnapshot(projectRoot, reference);
  while (true) {
    const state = loadQuestionState(projectRoot, reference, snapshot, questionId);
    const current = state.chain.current;
    if (current.state !== "claimed" && current.state !== "answer-pending" || !isActiveClaim(current, listenerId, claimToken, now)) {
      return false;
    }
    if (current.state === "answer-pending" && current.answer) {
      const answer = readPendingAnswer(projectRoot, reference, questionId, current.answer);
      if (answer) {
        const answered = nextGeneration(state, "answered", now, { answer: current.answer });
        if (tryPublishGeneration(projectRoot, reference, answered, options)) return false;
        continue;
      }
    }
    const failed = nextGeneration(state, "failed", now, { failureMessage });
    if (tryPublishGeneration(projectRoot, reference, failed, options)) return true;
  }
}
function reconcileExpiredQuestionsWithOptions(projectRoot, reference, now, options) {
  const snapshot = readAuthoritativeSnapshot(projectRoot, reference);
  const currentQuestions = readQuestionArtifacts(projectRoot, reference, snapshot).questions;
  for (const question of currentQuestions) {
    if (question.status !== "processing" || Date.parse(question.claim?.expiresAt ?? "") > now) {
      continue;
    }
    while (true) {
      const state = loadQuestionState(projectRoot, reference, snapshot, question.id);
      const current = state.chain.current;
      if (current.state !== "claimed" && current.state !== "answer-pending" || Date.parse(current.claim?.expiresAt ?? "") > now) {
        break;
      }
      if (current.state === "answer-pending") {
        reconcilePending(projectRoot, reference, state, now, options);
      } else {
        tryPublishGeneration(projectRoot, reference, nextGeneration(state, "queued", now), options);
      }
    }
  }
  return readQuestionArtifacts(projectRoot, reference, snapshot).questions;
}

// src/question-answer.ts
function writeAnswerWithOptions(projectRoot, reference, questionId, listenerId, claimToken, body, now, options) {
  if (body.trim().length === 0) throw new Error("review answer body must not be empty");
  const snapshot = readAuthoritativeSnapshot(projectRoot, reference);
  while (true) {
    let state = loadQuestionState(projectRoot, reference, snapshot, questionId);
    let current = state.chain.current;
    if (current.state === "answered") {
      const referenceData = current.answer;
      if (!referenceData) throw new Error("answered generation is missing answer data");
      const answer2 = readPendingAnswer(projectRoot, reference, questionId, referenceData);
      if (answer2 && referenceData.listenerId === listenerId && referenceData.bodyHash === hashText(body)) {
        return answer2;
      }
      throw new Error("review question claim is not owned by this listener");
    }
    if (current.state === "claimed") {
      if (!isActiveClaim(current, listenerId, claimToken, now)) {
        throw new Error("review question claim is not owned by this listener");
      }
      const answerReference2 = {
        id: answerId(questionId, claimToken),
        listenerId,
        bodyHash: hashText(body),
        createdAt: new Date(now).toISOString()
      };
      const pending = nextGeneration(state, "answer-pending", now, {
        claim: current.claim,
        answer: answerReference2
      });
      if (!tryPublishGeneration(projectRoot, reference, pending, options)) continue;
      state = loadQuestionState(projectRoot, reference, snapshot, questionId);
      current = state.chain.current;
    }
    if (current.state !== "answer-pending" || !isActiveClaim(current, listenerId, claimToken, now) || current.answer?.bodyHash !== hashText(body)) {
      throw new Error("review question claim is not owned by this listener");
    }
    const answerReference = current.answer;
    const answer = expectedAnswer(reference, questionId, answerReference, body);
    assertReviewAnswer(answer);
    const path = answerFile(projectRoot, reference, answer.id);
    if (!existsSync3(path)) {
      try {
        publishExclusiveText(
          path,
          serializeJson(answer),
          { kind: "answer", path, questionId },
          options,
          () => {
            const authorized = loadQuestionState(projectRoot, reference, snapshot, questionId).chain.current;
            if (authorized.state !== "answer-pending" || !isActiveClaim(authorized, listenerId, claimToken, now) || authorized.answer?.bodyHash !== answerReference.bodyHash) {
              throw new Error("review question claim is not owned by this listener");
            }
          },
          () => assertReviewArtifactPath(projectRoot, path)
        );
      } catch (error) {
        if (!isExactCommittedPublication(error) && errorCode(error) !== "EEXIST") throw error;
      }
    }
    const persisted = readPendingAnswer(projectRoot, reference, questionId, answerReference);
    if (!persisted) throw new Error("immutable review answer publication did not complete");
    state = loadQuestionState(projectRoot, reference, snapshot, questionId);
    current = state.chain.current;
    if (current.state === "answered") return persisted;
    if (current.state !== "answer-pending" || current.answer?.bodyHash !== answerReference.bodyHash) {
      throw new Error("review answer lost authorization before finalization");
    }
    const answered = nextGeneration(state, "answered", now, { answer: answerReference });
    if (tryPublishGeneration(projectRoot, reference, answered, options)) return persisted;
  }
}

// src/question-enqueue.ts
import { existsSync as existsSync4 } from "node:fs";
function enqueueQuestionWithOptions(projectRoot, reference, question, options) {
  assertSafeReviewSegment(question.id, "question");
  const snapshot = readAuthoritativeSnapshot(projectRoot, reference);
  const envelope = {
    ...question,
    schemaVersion: 1,
    workspaceId: reference.workspaceId,
    revisionId: reference.revisionId
  };
  assertReviewQuestionEnvelope(envelope);
  validateQuestionRelationship(envelope, reference, snapshot);
  const envelopeRaw = serializeJson(envelope);
  const envelopeHash = hashText(envelopeRaw);
  const initial = {
    schemaVersion: 1,
    questionId: question.id,
    workspaceId: reference.workspaceId,
    revisionId: reference.revisionId,
    generation: 0,
    predecessorGeneration: null,
    predecessorHash: null,
    envelopeHash,
    state: "queued",
    publishedAt: question.createdAt
  };
  const initialPath = generationFile(projectRoot, reference, question.id, 0);
  if (!existsSync4(initialPath)) {
    tryPublishGeneration(projectRoot, reference, initial, options);
  }
  const chain = readGenerationChain(projectRoot, reference, question.id);
  if (chain.current.envelopeHash !== envelopeHash) {
    throw new Error(`review question ${question.id} enqueue content conflicts with generation 0`);
  }
  const path = questionFile(projectRoot, reference, question.id);
  if (!existsSync4(path)) {
    try {
      publishExclusiveText(
        path,
        envelopeRaw,
        { kind: "question", path, questionId: question.id },
        options,
        void 0,
        () => assertReviewArtifactPath(projectRoot, path)
      );
    } catch (error) {
      if (!isExactCommittedPublication(error) && errorCode(error) !== "EEXIST") throw error;
    }
  }
  const persistedEnvelope = readEnvelopeArtifact(path);
  if (persistedEnvelope.raw !== envelopeRaw) {
    throw new Error(
      `review question ${question.id} enqueue content does not match existing envelope`
    );
  }
  return hydrateQuestion(persistedEnvelope.value, chain.current);
}

// src/questions.ts
var LISTENERS_DIRECTORY = ".listeners";
function listenerFile(projectRoot, reference, listenerId) {
  assertSafeReviewSegment(listenerId, "listener");
  return assertReviewArtifactPath(
    projectRoot,
    join5(questionDirectory(projectRoot, reference), LISTENERS_DIRECTORY, `${listenerId}.json`)
  );
}
function enqueueQuestion(projectRoot, reference, question) {
  return enqueueQuestionWithOptions(projectRoot, reference, question, {});
}
function listQuestions(projectRoot, reference) {
  return readQuestionArtifacts(projectRoot, reference).questions;
}
function reconcileExpiredQuestions(projectRoot, reference, now = Date.now()) {
  return reconcileExpiredQuestionsWithOptions(projectRoot, reference, now, {});
}
function claimQuestion(projectRoot, reference, questionId, listenerId, now, leaseMs) {
  return claimQuestionWithOptions(projectRoot, reference, questionId, listenerId, now, leaseMs, {});
}
function claimQuestions(projectRoot, reference, listenerId, now, leaseMs) {
  return listQuestions(projectRoot, reference).flatMap((question) => {
    if (question.status === "answered" || question.status === "stale") return [];
    const result = claimQuestion(projectRoot, reference, question.id, listenerId, now, leaseMs);
    return result.ok && result.question ? [result.question] : [];
  });
}
function renewClaim(projectRoot, reference, questionId, listenerId, claimToken, now, leaseMs) {
  return renewClaimWithOptions(
    projectRoot,
    reference,
    questionId,
    listenerId,
    claimToken,
    now,
    leaseMs,
    {}
  );
}
function releaseClaim(projectRoot, reference, questionId, listenerId, claimToken, now) {
  return releaseClaimWithOptions(
    projectRoot,
    reference,
    questionId,
    listenerId,
    claimToken,
    now,
    {}
  );
}
function failQuestion(projectRoot, reference, questionId, listenerId, claimToken, failureMessage, now) {
  return failQuestionWithOptions(
    projectRoot,
    reference,
    questionId,
    listenerId,
    claimToken,
    failureMessage,
    now,
    {}
  );
}
function writeAnswer(projectRoot, reference, questionId, listenerId, claimToken, body, now) {
  return writeAnswerWithOptions(
    projectRoot,
    reference,
    questionId,
    listenerId,
    claimToken,
    body,
    now,
    {}
  );
}
function touchReviewListener(projectRoot, reference, listenerId, now = Date.now()) {
  readAuthoritativeSnapshot(projectRoot, reference);
  assertSafeReviewSegment(listenerId, "listener");
  const path = listenerFile(projectRoot, reference, listenerId);
  mkdirSync2(dirname2(path), { recursive: true });
  atomicWriteJson(path, { listenerId, updatedAt: new Date(now).toISOString() });
}
function removeReviewListener(projectRoot, reference, listenerId) {
  assertSafeReviewSegment(listenerId, "listener");
  rmSync2(listenerFile(projectRoot, reference, listenerId), { force: true });
}
function createQuestionQueue(projectRoot, reference, options = {}) {
  return {
    enqueue: (question) => enqueueQuestionWithOptions(projectRoot, reference, question, options),
    list: () => readQuestionArtifacts(projectRoot, reference).questions,
    claim: (questionId, listenerId, now, leaseMs) => claimQuestionWithOptions(
      projectRoot,
      reference,
      questionId,
      listenerId,
      now,
      leaseMs,
      options
    ),
    renew: (questionId, listenerId, claimToken, now, leaseMs) => renewClaimWithOptions(
      projectRoot,
      reference,
      questionId,
      listenerId,
      claimToken,
      now,
      leaseMs,
      options
    ),
    release: (questionId, listenerId, claimToken, now) => releaseClaimWithOptions(
      projectRoot,
      reference,
      questionId,
      listenerId,
      claimToken,
      now,
      options
    ),
    fail: (questionId, listenerId, claimToken, failureMessage, now) => failQuestionWithOptions(
      projectRoot,
      reference,
      questionId,
      listenerId,
      claimToken,
      failureMessage,
      now,
      options
    ),
    answer: (questionId, listenerId, claimToken, body, now) => writeAnswerWithOptions(
      projectRoot,
      reference,
      questionId,
      listenerId,
      claimToken,
      body,
      now,
      options
    ),
    readQuestion: (questionId) => {
      const path = questionFile(projectRoot, reference, questionId);
      if (!existsSync5(path)) return void 0;
      const snapshot = readAuthoritativeSnapshot(projectRoot, reference);
      const state = loadQuestionState(projectRoot, reference, snapshot, questionId);
      return hydrateQuestion(state.envelope, state.chain.current);
    },
    readAnswer: (id) => readQuestionArtifacts(projectRoot, reference).answers.find((answer) => answer.id === id),
    touchListener: (listenerId, now) => touchReviewListener(projectRoot, reference, listenerId, now),
    removeListener: (listenerId) => removeReviewListener(projectRoot, reference, listenerId)
  };
}
function loadReviewQuestionArtifacts(projectRoot, reference, snapshot) {
  return readQuestionArtifacts(projectRoot, reference, snapshot);
}
function reviewQuestionsDirectory(projectRoot, reference) {
  return questionDirectory(projectRoot, reference);
}

// src/store.ts
var activeWorkspaceLockTokens = /* @__PURE__ */ new Set();
function readJson(path) {
  let serialized;
  try {
    serialized = readFileSync4(path, "utf8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      throw new ReviewCoreError("review_not_found", `review artifact was not found: ${path}`);
    }
    throw new Error(`unable to read review artifact ${path}: ${detail}`);
  }
  try {
    return JSON.parse(serialized);
  } catch {
    throw new ReviewCoreError("review_corrupt", `review artifact contains invalid JSON: ${path}`);
  }
}
function readValidated(path, assertValue) {
  const value = readJson(path);
  try {
    assertValue(value);
  } catch (error) {
    if (error instanceof ReviewCoreError) throw error;
    throw new ReviewCoreError("review_corrupt", `review artifact failed validation: ${path}`);
  }
  return value;
}
function validateRevisionRelationships(workspace, snapshot, insights, progress, requireCompleteInsights = false) {
  if (workspace.currentRevisionId !== snapshot.revisionId || insights.revisionId !== snapshot.revisionId) {
    throw new Error("review revision artifacts must share the same revision id");
  }
  if (stableJson(workspace.source) !== stableJson(snapshot.source)) {
    throw new Error("review workspace source must match its current snapshot source");
  }
  const itemIds = new Set(snapshot.items.map((item) => item.id));
  if (itemIds.size !== snapshot.items.length) {
    throw new Error("review snapshot contains duplicate review item ids");
  }
  for (const group of insights.groups) {
    if (group.reviewItemIds.some((reviewItemId) => !itemIds.has(reviewItemId))) {
      throw new Error("review insights reference unknown review item");
    }
  }
  if (insights.items.some((insight) => !itemIds.has(insight.reviewItemId))) {
    throw new Error("review insights reference unknown review item");
  }
  if (insights.files !== void 0) {
    const knownPaths = new Set(snapshot.files.map((file) => file.path));
    const seen = /* @__PURE__ */ new Set();
    for (const file of insights.files) {
      if (!knownPaths.has(file.path)) {
        throw new Error(`file insight references unknown path: ${file.path}`);
      }
      if (seen.has(file.path)) {
        throw new Error(`duplicate file insight path: ${file.path}`);
      }
      seen.add(file.path);
    }
  }
  if (snapshot.kind === "scope") {
    const filePaths = new Set(snapshot.files.map((file) => file.path));
    for (const item of snapshot.items) {
      if (item.kind !== "code-section") {
        throw new Error("scoped review snapshots may contain only code-section items");
      }
      if (!filePaths.has(item.path)) {
        throw new Error("scoped review item references an unknown source file");
      }
    }
  } else {
    const itemsById = new Map(snapshot.items.map((item) => [item.id, item]));
    const linkedItems = /* @__PURE__ */ new Set();
    const assertLink = (reviewItemId, contentHash, locationHash, path, expectedKind, label) => {
      const item = reviewItemId ? itemsById.get(reviewItemId) : void 0;
      if (!item || item.kind !== expectedKind || item.path !== path || item.contentHash !== contentHash || item.locationHash !== locationHash || linkedItems.has(item.id)) {
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
          "file",
          "zero-hunk diff file"
        );
        continue;
      }
      if (file.reviewItemId !== void 0 || file.reviewItemContentHash !== void 0 || file.reviewItemLocationHash !== void 0) {
        throw new Error("textual diff files cannot carry a file-level review item link");
      }
      for (const hunk of file.hunks) {
        assertLink(
          hunk.reviewItemId,
          hunk.reviewItemContentHash,
          hunk.reviewItemLocationHash,
          file.path,
          "hunk",
          "diff hunk"
        );
      }
    }
    if (linkedItems.size !== snapshot.items.length) {
      throw new Error("every diff review item must have exactly one file or hunk link");
    }
  }
  for (const item of snapshot.items) {
    const context = resolveReviewItemContext(snapshot, item.id);
    if (snapshot.kind === "scope" && hashText(context.rows.map((row) => row.text).join("\n")) !== item.contentHash) {
      throw new Error("scoped review item content does not match its captured source lines");
    }
    if (snapshot.kind === "diff" && item.kind === "file") {
      const file = snapshot.files.find((candidate) => candidate.reviewItemId === item.id);
      if (!file || stableJson(createFileReviewItem(file)) !== stableJson(item)) {
        throw new Error("diff file review item does not match canonical captured metadata");
      }
    }
  }
  const progressIds = Object.keys(progress.items);
  for (const progressId of progressIds) {
    if (!itemIds.has(progressId)) {
      throw new Error("review progress references an unknown review item");
    }
  }
  if (progressIds.length !== itemIds.size) {
    throw new Error("review progress must cover every review item");
  }
  for (const [reviewItemId, itemProgress] of Object.entries(progress.items)) {
    if (itemProgress.status === "reviewed") {
      if (!itemProgress.reviewedAt)
        throw new Error("reviewed status requires a reviewed timestamp");
      if (itemProgress.inheritedFrom) {
        throw new Error("directly reviewed status cannot carry inherited provenance");
      }
    } else if (itemProgress.status === "carried-forward") {
      if (!itemProgress.reviewedAt || !itemProgress.inheritedFrom) {
        throw new Error("carried-forward status requires a timestamp and inherited provenance");
      }
      if (snapshot.predecessorRevisionId === void 0 || itemProgress.inheritedFrom.revisionId !== snapshot.predecessorRevisionId) {
        throw new Error("carried-forward provenance must reference the direct predecessor");
      }
      if (itemProgress.inheritedFrom.reviewItemId.length === 0 || reviewItemId.length === 0) {
        throw new Error("carried-forward provenance must identify both review items");
      }
    } else if (itemProgress.reviewedAt || itemProgress.inheritedFrom) {
      throw new Error("pending or stale review status cannot carry reviewed provenance");
    }
  }
  if (progress.activeReviewItemId && !itemIds.has(progress.activeReviewItemId)) {
    throw new Error("active review item references an unknown review item");
  }
  if (progress.activeFile && !snapshot.files.some((file) => file.path === progress.activeFile)) {
    throw new Error("active review file references an unknown captured file");
  }
  const isPendingInsights = insights.groups.length === 0 && insights.items.length === 0;
  if (requireCompleteInsights && !isPendingInsights && itemIds.size === 0) {
    throw new Error("finalized review analysis for an empty snapshot must be empty");
  }
  if (!isPendingInsights || requireCompleteInsights) {
    const capturedPaths = new Set(snapshot.files.map((file) => file.path));
    for (const insight of insights.items) {
      if (insight.evidencePaths.length === 0 || new Set(insight.evidencePaths).size !== insight.evidencePaths.length || insight.evidencePaths.some((path) => !capturedPaths.has(path))) {
        throw new Error("review insight evidence must reference unique captured files");
      }
    }
    if (insights.groups.some((group) => group.reviewItemIds.length === 0)) {
      throw new Error("finalized review groups must not be empty");
    }
    const insightIds = insights.items.map((insight) => insight.reviewItemId);
    if (insightIds.length !== itemIds.size || new Set(insightIds).size !== insightIds.length || insightIds.some((id) => !itemIds.has(id))) {
      throw new Error("finalized review insights must cover every review item exactly once");
    }
    const groupedIds = insights.groups.flatMap((group) => group.reviewItemIds);
    if (groupedIds.length !== itemIds.size || new Set(groupedIds).size !== groupedIds.length || groupedIds.some((id) => !itemIds.has(id))) {
      throw new Error("finalized review groups must cover every review item exactly once");
    }
    if (new Set(insights.groups.map((group) => group.id)).size !== insights.groups.length) {
      throw new Error("finalized review group ids must be unique");
    }
    if (progress.activeGroupId && !insights.groups.some((group) => group.id === progress.activeGroupId)) {
      throw new Error("active review group references an unknown insight group");
    }
  } else {
    if (progress.activeGroupId) {
      throw new Error("pending review analysis cannot select an active group");
    }
    if (insights.groups.length !== insights.items.length) {
      throw new Error("pending review analysis cannot be partially populated");
    }
  }
  for (const group of insights.groups) {
    for (const reviewItemId of group.reviewItemIds) {
      if (!itemIds.has(reviewItemId)) {
        throw new Error("review insights reference unknown review item");
      }
    }
  }
  for (const insight of insights.items) {
    if (!itemIds.has(insight.reviewItemId)) {
      throw new Error("review insights reference unknown review item");
    }
  }
}
function lockFile(projectRoot, workspaceId) {
  return assertReviewArtifactPath(
    projectRoot,
    join6(reviewWorkspaceDir(projectRoot, workspaceId), ".review-lock")
  );
}
function finalizedBundleFile(projectRoot, workspaceId, revisionId) {
  return assertReviewArtifactPath(
    projectRoot,
    join6(reviewRevisionDir(projectRoot, workspaceId, revisionId), "bundle.json")
  );
}
function validateRevisionPredecessor(projectRoot, workspace, snapshot) {
  const existingWorkspacePath = workspaceFile(projectRoot, workspace.id);
  if (!existsSync6(existingWorkspacePath)) {
    if (snapshot.predecessorRevisionId !== void 0) {
      throw new ReviewCoreError(
        "review_conflict",
        "an initial review revision cannot declare a predecessor"
      );
    }
    return;
  }
  const currentWorkspace = readValidated(existingWorkspacePath, assertReviewWorkspace);
  if (snapshot.predecessorRevisionId !== currentWorkspace.currentRevisionId) {
    throw new ReviewCoreError(
      "review_conflict",
      "review predecessor must be the current workspace revision"
    );
  }
  readValidated(
    snapshotFile(projectRoot, workspace.id, snapshot.predecessorRevisionId),
    assertReviewSnapshot
  );
}
function readFinalizedBundle(projectRoot, workspaceId, revisionId) {
  const path = finalizedBundleFile(projectRoot, workspaceId, revisionId);
  if (!existsSync6(path)) return void 0;
  const value = readJson(path);
  if (typeof value !== "object" || value === null || !("finalized" in value) || value.finalized !== true) {
    throw new ReviewCoreError("review_corrupt", `invalid finalized review bundle ${path}`);
  }
  if (!("schemaVersion" in value) || value.schemaVersion !== 1 || !("snapshot" in value) || !("insights" in value) || !("progress" in value)) {
    throw new ReviewCoreError("review_corrupt", `invalid finalized review bundle ${path}`);
  }
  try {
    assertReviewSnapshot(value.snapshot);
    assertReviewInsights(value.insights);
    assertReviewProgress(value.progress);
  } catch {
    throw new ReviewCoreError("review_corrupt", `invalid finalized review bundle ${path}`);
  }
  const finalizedAt = "finalizedAt" in value ? value.finalizedAt : void 0;
  if (finalizedAt !== void 0) assertFinalizedAt(finalizedAt);
  return {
    schemaVersion: 1,
    finalized: true,
    ...typeof finalizedAt === "string" ? { finalizedAt } : {},
    snapshot: value.snapshot,
    insights: value.insights,
    progress: value.progress
  };
}
function assertFinalizedAt(value) {
  if (typeof value !== "string" || value.length === 0 || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new ReviewCoreError("review_corrupt", "invalid review analysis finalization timestamp");
  }
}
function validateInheritedProgress(projectRoot, workspaceId, snapshot, progress) {
  const inherited = Object.entries(progress.items).filter(
    ([, itemProgress]) => itemProgress.status === "carried-forward"
  );
  if (inherited.length === 0) return;
  const predecessorRevisionId = snapshot.predecessorRevisionId;
  if (!predecessorRevisionId) {
    throw new Error("carried-forward progress requires a direct predecessor");
  }
  const finalized = readFinalizedBundle(projectRoot, workspaceId, predecessorRevisionId);
  const predecessorSnapshot = finalized?.snapshot ?? readValidated(
    snapshotFile(projectRoot, workspaceId, predecessorRevisionId),
    assertReviewSnapshot
  );
  const predecessorProgress = finalized?.progress ?? readValidated(
    progressFile(projectRoot, workspaceId, predecessorRevisionId),
    assertReviewProgress
  );
  if (predecessorSnapshot.revisionId !== predecessorRevisionId) {
    throw new Error("carried-forward predecessor snapshot identity is corrupt");
  }
  for (const [currentId, itemProgress] of inherited) {
    const currentItem = snapshot.items.find((item) => item.id === currentId);
    const predecessorId = itemProgress.inheritedFrom?.reviewItemId;
    const predecessorItem = predecessorSnapshot.items.find((item) => item.id === predecessorId);
    const predecessorState = predecessorId ? predecessorProgress.items[predecessorId] : void 0;
    if (!currentItem || !predecessorItem || predecessorState?.status !== "reviewed" && predecessorState?.status !== "carried-forward" || reconciliationKey(currentItem) !== reconciliationKey(predecessorItem)) {
      throw new Error("carried-forward provenance does not match carryable predecessor progress");
    }
    if (currentId === predecessorId) continue;
    const key = reconciliationKey(currentItem);
    const previousMatches = predecessorSnapshot.items.filter((item) => {
      const state = predecessorProgress.items[item.id];
      return reconciliationKey(item) === key && (state?.status === "reviewed" || state?.status === "carried-forward");
    });
    const currentMatches = snapshot.items.filter((item) => reconciliationKey(item) === key);
    if (previousMatches.length !== 1 || currentMatches.length !== 1) {
      throw new Error("carried-forward moved-item provenance is ambiguous");
    }
  }
}
function publishFinalizedBundle(projectRoot, workspaceId, revisionId, snapshot, insights, progress, beforePublish, finalizedAt) {
  if (finalizedAt !== void 0) assertFinalizedAt(finalizedAt);
  beforePublish?.();
  atomicWriteJson(finalizedBundleFile(projectRoot, workspaceId, revisionId), {
    schemaVersion: 1,
    finalized: true,
    ...finalizedAt !== void 0 ? { finalizedAt } : {},
    snapshot,
    insights,
    progress
  });
}
function publishProgress(projectRoot, workspaceId, revisionId, finalized, progress, options) {
  if (finalized) {
    publishFinalizedBundle(
      projectRoot,
      workspaceId,
      revisionId,
      finalized.snapshot,
      finalized.insights,
      progress,
      options.beforeFinalizedBundlePublish,
      finalized.finalizedAt
    );
    return;
  }
  options.beforeProgressPublish?.();
  atomicWriteJson(progressFile(projectRoot, workspaceId, revisionId), progress);
}
function nextProgressUpdatedAt(previous, now) {
  const previousMs = Date.parse(previous);
  return new Date(Number.isFinite(previousMs) ? Math.max(now, previousMs + 1) : now).toISOString();
}
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
function storageErrorCode(error) {
  return typeof error === "object" && error !== null && "code" in error ? String(error.code) : void 0;
}
function parseWorkspaceLockOwner(raw) {
  try {
    const value = JSON.parse(raw);
    if (typeof value !== "object" || value === null || !("schemaVersion" in value) || value.schemaVersion !== 1 || !("pid" in value) || !Number.isSafeInteger(value.pid) || Number(value.pid) <= 0 || !("token" in value) || typeof value.token !== "string" || value.token.length === 0 || !("createdAt" in value) || typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))) {
      return void 0;
    }
    return value;
  } catch {
    return void 0;
  }
}
function defaultIsProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return storageErrorCode(error) === "EPERM";
  }
}
function recoverAbandonedWorkspaceLock(projectRoot, path, isProcessAlive) {
  assertReviewArtifactPath(projectRoot, path);
  let descriptor;
  try {
    descriptor = openSync2(path, "r");
    const inspected = fstatSync(descriptor);
    const owner = parseWorkspaceLockOwner(readFileSync4(descriptor, "utf8"));
    if (!owner) return false;
    const isActiveHere = owner.pid === process.pid && activeWorkspaceLockTokens.has(owner.token);
    const isAliveElsewhere = owner.pid !== process.pid && isProcessAlive(owner.pid);
    if (isActiveHere || isAliveElsewhere) return false;
    assertReviewArtifactPath(projectRoot, path);
    const current = lstatSync2(path);
    const currentOwner = parseWorkspaceLockOwner(readFileSync4(path, "utf8"));
    if (current.dev !== inspected.dev || current.ino !== inspected.ino || currentOwner?.token !== owner.token || currentOwner.pid !== owner.pid) {
      return false;
    }
    unlinkSync(path);
    return true;
  } catch (error) {
    if (storageErrorCode(error) === "ENOENT") return true;
    return false;
  } finally {
    if (descriptor !== void 0) {
      try {
        closeSync2(descriptor);
      } catch {
      }
    }
  }
}
function releaseOwnedWorkspaceLock(projectRoot, path, owner) {
  assertReviewArtifactPath(projectRoot, path);
  let persisted;
  try {
    persisted = parseWorkspaceLockOwner(readFileSync4(path, "utf8"));
  } catch (error) {
    if (storageErrorCode(error) === "ENOENT") return;
    throw error;
  }
  if (persisted?.token !== owner.token || persisted.pid !== owner.pid) {
    throw new ReviewCoreError("review_internal", "review workspace lock ownership changed");
  }
  unlinkSync(path);
}
function withWorkspaceLock(projectRoot, workspaceId, operation, openLockFile = openSync2, closeLockFile = closeSync2, isProcessAlive = defaultIsProcessAlive) {
  const workspaceDirectory = reviewWorkspaceDir(projectRoot, workspaceId);
  mkdirSync3(workspaceDirectory, { recursive: true });
  const lockPath = lockFile(projectRoot, workspaceId);
  const owner = {
    schemaVersion: 1,
    pid: process.pid,
    token: randomUUID3(),
    createdAt: (/* @__PURE__ */ new Date()).toISOString()
  };
  let descriptor;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      assertReviewArtifactPath(projectRoot, lockPath);
      descriptor = openLockFile(lockPath, "wx");
      break;
    } catch (error) {
      if (storageErrorCode(error) !== "EEXIST") {
        throw new ReviewCoreError("review_internal", "unable to acquire review workspace lock");
      }
      if (attempt === 0 && recoverAbandonedWorkspaceLock(projectRoot, lockPath, isProcessAlive)) {
        continue;
      }
      throw new ReviewCoreError("review_busy", "review workspace is busy; retry the operation");
    }
  }
  if (descriptor === void 0) {
    throw new ReviewCoreError("review_internal", "unable to acquire review workspace lock");
  }
  let acquired = false;
  try {
    writeFileSync3(descriptor, `${JSON.stringify(owner)}
`, "utf8");
    fsyncSync2(descriptor);
    activeWorkspaceLockTokens.add(owner.token);
    acquired = true;
  } catch (error) {
    try {
      closeLockFile(descriptor);
    } finally {
      try {
        unlinkSync(lockPath);
      } catch {
      }
    }
    throw error;
  }
  let result;
  let operationError;
  try {
    result = operation();
  } catch (error) {
    operationError = error;
  }
  let cleanupError;
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
  if (operationError !== void 0) throw operationError;
  if (cleanupError !== void 0) throw cleanupError;
  return result;
}
function createReviewStore(projectRoot, options = {}) {
  const withLock = (workspaceId, operation) => withWorkspaceLock(
    projectRoot,
    workspaceId,
    operation,
    options.openLockFile,
    options.closeLockFile,
    options.isProcessAlive
  );
  return {
    createRevision(workspace, snapshot, insights, progress) {
      assertReviewWorkspace(workspace);
      assertReviewSnapshot(snapshot);
      assertReviewInsights(insights);
      assertReviewProgress(progress);
      validateRevisionRelationships(workspace, snapshot, insights, progress);
      withLock(workspace.id, () => {
        const revisionDir = reviewRevisionDir(projectRoot, workspace.id, snapshot.revisionId);
        if (existsSync6(revisionDir)) {
          const existingWorkspacePath = workspaceFile(projectRoot, workspace.id);
          const currentWorkspace = existsSync6(existingWorkspacePath) ? readValidated(existingWorkspacePath, assertReviewWorkspace) : void 0;
          const canRecoverPointer = currentWorkspace ? currentWorkspace.currentRevisionId === snapshot.predecessorRevisionId : snapshot.predecessorRevisionId === void 0;
          const existingSnapshot = readValidated(
            snapshotFile(projectRoot, workspace.id, snapshot.revisionId),
            assertReviewSnapshot
          );
          const existingInsights = readValidated(
            insightsFile(projectRoot, workspace.id, snapshot.revisionId),
            assertReviewInsights
          );
          const existingProgress = readValidated(
            progressFile(projectRoot, workspace.id, snapshot.revisionId),
            assertReviewProgress
          );
          const isExactOrphan = canRecoverPointer && stableJson(existingSnapshot) === stableJson(snapshot) && stableJson(existingInsights) === stableJson(insights) && stableJson(existingProgress) === stableJson(progress);
          if (!isExactOrphan) {
            throw new ReviewCoreError("review_conflict", "review revision already exists");
          }
          options.beforeWorkspacePublish?.();
          atomicWriteJson(existingWorkspacePath, workspace);
          return;
        }
        validateRevisionPredecessor(projectRoot, workspace, snapshot);
        validateInheritedProgress(projectRoot, workspace.id, snapshot, progress);
        const stagingRoot = assertReviewArtifactPath(
          projectRoot,
          join6(reviewWorkspaceDir(projectRoot, workspace.id), ".revision-staging")
        );
        mkdirSync3(stagingRoot, { recursive: true });
        const temporaryDir = assertReviewArtifactPath(
          projectRoot,
          join6(stagingRoot, `${snapshot.revisionId}-${process.pid}-${randomUUID3()}`)
        );
        try {
          mkdirSync3(dirname3(revisionDir), { recursive: true });
          mkdirSync3(temporaryDir, { recursive: true });
          mkdirSync3(join6(temporaryDir, "questions"), { recursive: true });
          mkdirSync3(join6(temporaryDir, "answers"), { recursive: true });
          atomicWriteJson(join6(temporaryDir, "snapshot.json"), snapshot);
          atomicWriteJson(join6(temporaryDir, "insights.json"), insights);
          atomicWriteJson(join6(temporaryDir, "progress.json"), progress);
          renameSync2(temporaryDir, revisionDir);
          options.beforeWorkspacePublish?.();
          atomicWriteJson(workspaceFile(projectRoot, workspace.id), workspace);
        } catch (error) {
          rmSync3(temporaryDir, { recursive: true, force: true });
          throw error;
        }
      });
    },
    readBundle(workspaceId, revisionId) {
      try {
        const workspace = this.readWorkspace(workspaceId);
        if (workspace.id !== workspaceId) {
          throw new Error("review workspace id does not match requested workspace");
        }
        const finalized = readFinalizedBundle(projectRoot, workspaceId, revisionId);
        const snapshot = finalized?.snapshot ?? readValidated(snapshotFile(projectRoot, workspaceId, revisionId), assertReviewSnapshot);
        const insights = finalized?.insights ?? readValidated(insightsFile(projectRoot, workspaceId, revisionId), assertReviewInsights);
        const progress = finalized?.progress ?? readValidated(progressFile(projectRoot, workspaceId, revisionId), assertReviewProgress);
        const revisionWorkspace = {
          ...workspace,
          source: snapshot.source,
          currentRevisionId: snapshot.revisionId
        };
        validateRevisionRelationships(
          revisionWorkspace,
          snapshot,
          insights,
          progress,
          finalized !== void 0
        );
        validateInheritedProgress(projectRoot, workspaceId, snapshot, progress);
        const { questions, answers } = loadReviewQuestionArtifacts(
          projectRoot,
          { workspaceId, revisionId },
          snapshot
        );
        return {
          workspace: revisionWorkspace,
          snapshot,
          insights,
          progress,
          questions,
          answers,
          sourceChanged: false
        };
      } catch (error) {
        if (error instanceof ReviewCoreError) throw error;
        const detail = error instanceof Error ? error.message : "invalid review bundle artifact";
        throw new ReviewCoreError("review_corrupt", detail);
      }
    },
    readWorkspace(workspaceId) {
      const workspace = readValidated(
        workspaceFile(projectRoot, workspaceId),
        assertReviewWorkspace
      );
      if (workspace.id !== workspaceId) {
        throw new ReviewCoreError(
          "review_corrupt",
          "review workspace id does not match requested workspace"
        );
      }
      return workspace;
    },
    listWorkspaces() {
      const directory = reviewsDir(projectRoot);
      if (!existsSync6(directory)) return [];
      return readdirSync3(directory).sort().filter((entry) => {
        try {
          assertSafeReviewSegment(entry, "workspace");
          return true;
        } catch {
          return false;
        }
      }).map((entry) => this.readWorkspace(entry));
    },
    findRevisionByFingerprint(workspaceId, fingerprint) {
      const revisionDirectory = reviewWorkspaceDir(projectRoot, workspaceId);
      if (!existsSync6(revisionDirectory)) return void 0;
      const revisionsDirectory = assertReviewArtifactPath(
        projectRoot,
        join6(revisionDirectory, "revisions")
      );
      if (!existsSync6(revisionsDirectory)) return void 0;
      const revisionIds = readdirSync3(revisionsDirectory).sort().filter((revisionId) => {
        try {
          assertSafeReviewSegment(revisionId, "revision");
          return true;
        } catch {
          return false;
        }
      });
      for (const revisionId of revisionIds) {
        const path = snapshotFile(projectRoot, workspaceId, revisionId);
        if (!existsSync6(path)) continue;
        const snapshot = readValidated(path, assertReviewSnapshot);
        if (snapshot.revisionId !== revisionId) continue;
        if (snapshot.fingerprint === fingerprint) return revisionId;
      }
      return void 0;
    },
    writeInitialInsights(workspaceId, revisionId, insights, finalizedAt) {
      withLock(workspaceId, () => {
        if (readFinalizedBundle(projectRoot, workspaceId, revisionId)) {
          throw new ReviewCoreError(
            "review_conflict",
            "review analysis already exists and is immutable"
          );
        }
        const workspace = this.readWorkspace(workspaceId);
        const snapshot = readValidated(
          snapshotFile(projectRoot, workspaceId, revisionId),
          assertReviewSnapshot
        );
        const current = readValidated(
          insightsFile(projectRoot, workspaceId, revisionId),
          assertReviewInsights
        );
        if (current.revisionId !== revisionId) {
          throw new Error("stored review insights revision does not match requested revision");
        }
        if (current.groups.length > 0 || current.items.length > 0) {
          throw new ReviewCoreError(
            "review_conflict",
            "review analysis already exists and is immutable"
          );
        }
        if (insights.revisionId !== revisionId) {
          throw new Error("review insights revision does not match requested revision");
        }
        assertReviewInsights(insights);
        const progress = readValidated(
          progressFile(projectRoot, workspaceId, revisionId),
          assertReviewProgress
        );
        validateRevisionRelationships(
          { ...workspace, currentRevisionId: revisionId },
          snapshot,
          insights,
          progress,
          true
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
          finalizedAt ?? new Date(options.now?.() ?? Date.now()).toISOString()
        );
      });
    },
    finalizeScopeAnalysis(workspaceId, revisionId, snapshot, insights, progress, finalizedAt) {
      withLock(workspaceId, () => {
        if (readFinalizedBundle(projectRoot, workspaceId, revisionId)) {
          throw new ReviewCoreError(
            "review_conflict",
            "review analysis already exists and is immutable"
          );
        }
        const workspace = this.readWorkspace(workspaceId);
        const existingSnapshot = readValidated(
          snapshotFile(projectRoot, workspaceId, revisionId),
          assertReviewSnapshot
        );
        const currentInsights = readValidated(
          insightsFile(projectRoot, workspaceId, revisionId),
          assertReviewInsights
        );
        if (existingSnapshot.kind !== "scope" || snapshot.kind !== "scope") {
          throw new Error("only scoped review snapshots can be finalized with code sections");
        }
        if (currentInsights.groups.length > 0 || currentInsights.items.length > 0) {
          throw new ReviewCoreError(
            "review_conflict",
            "review analysis already exists and is immutable"
          );
        }
        const immutablePending = { ...existingSnapshot, items: [] };
        const immutableProposed = { ...snapshot, items: [] };
        if (stableJson(immutablePending) !== stableJson(immutableProposed)) {
          throw new Error("scoped finalization cannot modify immutable captured source data");
        }
        validateRevisionRelationships(
          { ...workspace, currentRevisionId: revisionId },
          snapshot,
          insights,
          progress,
          true
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
          finalizedAt ?? new Date(options.now?.() ?? Date.now()).toISOString()
        );
      });
    },
    setCurrentRevision(workspaceId, revisionId, source, repository) {
      withLock(workspaceId, () => {
        const snapshot = readValidated(
          snapshotFile(projectRoot, workspaceId, revisionId),
          assertReviewSnapshot
        );
        if (snapshot.revisionId !== revisionId) {
          throw new ReviewCoreError(
            "review_corrupt",
            "review snapshot revision does not match requested revision"
          );
        }
        if (stableJson(source) !== stableJson(snapshot.source)) {
          throw new ReviewCoreError(
            "review_conflict",
            "review workspace source must match the target snapshot source"
          );
        }
        let workspace;
        try {
          workspace = this.readWorkspace(workspaceId);
        } catch (error) {
          if (!isReviewCoreError(error) || error.code !== "review_not_found") throw error;
          const insights = readValidated(
            insightsFile(projectRoot, workspaceId, revisionId),
            assertReviewInsights
          );
          const progress = readValidated(
            progressFile(projectRoot, workspaceId, revisionId),
            assertReviewProgress
          );
          workspace = {
            schemaVersion: 1,
            id: workspaceId,
            repository: repository ?? { root: projectRoot, name: basename2(projectRoot) },
            source,
            currentRevisionId: revisionId,
            createdAt: snapshot.createdAt,
            updatedAt: snapshot.createdAt
          };
          assertReviewWorkspace(workspace);
          validateRevisionRelationships(workspace, snapshot, insights, progress);
          validateInheritedProgress(projectRoot, workspaceId, snapshot, progress);
        }
        const next = {
          ...workspace,
          source,
          currentRevisionId: revisionId,
          updatedAt: nextProgressUpdatedAt(workspace.updatedAt, options.now?.() ?? Date.now())
        };
        assertReviewWorkspace(next);
        atomicWriteJson(workspaceFile(projectRoot, workspaceId), next);
      });
    },
    isAnalysisFinalized(workspaceId, revisionId) {
      return readFinalizedBundle(projectRoot, workspaceId, revisionId) !== void 0;
    },
    getAnalysisFinalizedAt(workspaceId, revisionId) {
      return readFinalizedBundle(projectRoot, workspaceId, revisionId)?.finalizedAt;
    },
    updateProgress(workspaceId, revisionId, update) {
      return withLock(workspaceId, () => {
        const finalized = readFinalizedBundle(projectRoot, workspaceId, revisionId);
        const snapshot = finalized?.snapshot ?? readValidated(snapshotFile(projectRoot, workspaceId, revisionId), assertReviewSnapshot);
        const insights = finalized?.insights ?? readValidated(insightsFile(projectRoot, workspaceId, revisionId), assertReviewInsights);
        const current = finalized?.progress ?? readValidated(progressFile(projectRoot, workspaceId, revisionId), assertReviewProgress);
        const next = {
          ...current,
          ...update,
          items: {
            ...current.items,
            ...Object.fromEntries(
              Object.entries(update.items ?? {}).map(([reviewItemId, item]) => [
                reviewItemId,
                item.status === "reviewed" && !item.reviewedAt ? {
                  ...item,
                  reviewedAt: new Date(options.now?.() ?? Date.now()).toISOString()
                } : item
              ])
            )
          },
          updatedAt: nextProgressUpdatedAt(current.updatedAt, options.now?.() ?? Date.now())
        };
        assertReviewProgress(next);
        const workspace = this.readWorkspace(workspaceId);
        validateRevisionRelationships(
          { ...workspace, source: snapshot.source, currentRevisionId: revisionId },
          snapshot,
          insights,
          next,
          finalized !== void 0
        );
        validateInheritedProgress(projectRoot, workspaceId, snapshot, next);
        publishProgress(projectRoot, workspaceId, revisionId, finalized, next, options);
        return next;
      });
    },
    patchItemProgress(workspaceId, revisionId, reviewItemId, patch) {
      return withLock(workspaceId, () => {
        const finalized = readFinalizedBundle(projectRoot, workspaceId, revisionId);
        const snapshot = finalized?.snapshot ?? readValidated(snapshotFile(projectRoot, workspaceId, revisionId), assertReviewSnapshot);
        const insights = finalized?.insights ?? readValidated(insightsFile(projectRoot, workspaceId, revisionId), assertReviewInsights);
        const current = finalized?.progress ?? readValidated(progressFile(projectRoot, workspaceId, revisionId), assertReviewProgress);
        const currentItem = current.items[reviewItemId] ?? { status: "needs-review" };
        const status = patch.status ?? currentItem.status;
        const note = patch.note === void 0 ? currentItem.note : patch.note ?? void 0;
        const reviewedAt = status === "reviewed" ? patch.status === "reviewed" ? new Date(options.now?.() ?? Date.now()).toISOString() : currentItem.reviewedAt : void 0;
        const item = {
          status,
          ...note === void 0 ? {} : { note },
          ...reviewedAt === void 0 ? {} : { reviewedAt },
          ...patch.status === void 0 && currentItem.inheritedFrom ? { inheritedFrom: currentItem.inheritedFrom } : {}
        };
        const next = {
          ...current,
          items: { ...current.items, [reviewItemId]: item },
          updatedAt: nextProgressUpdatedAt(current.updatedAt, options.now?.() ?? Date.now())
        };
        assertReviewProgress(next);
        const workspace = this.readWorkspace(workspaceId);
        validateRevisionRelationships(
          { ...workspace, source: snapshot.source, currentRevisionId: revisionId },
          snapshot,
          insights,
          next,
          finalized !== void 0
        );
        validateInheritedProgress(projectRoot, workspaceId, snapshot, next);
        publishProgress(projectRoot, workspaceId, revisionId, finalized, next, options);
        return next;
      });
    },
    patchWalkthroughPosition(workspaceId, revisionId, position) {
      return withLock(workspaceId, () => {
        const finalized = readFinalizedBundle(projectRoot, workspaceId, revisionId);
        const snapshot = finalized?.snapshot ?? readValidated(snapshotFile(projectRoot, workspaceId, revisionId), assertReviewSnapshot);
        const insights = finalized?.insights ?? readValidated(insightsFile(projectRoot, workspaceId, revisionId), assertReviewInsights);
        const current = finalized?.progress ?? readValidated(progressFile(projectRoot, workspaceId, revisionId), assertReviewProgress);
        const group = insights.groups.find((candidate) => candidate.id === position.activeGroupId);
        if (!group) {
          throw new Error(`unknown walkthrough group: ${position.activeGroupId}`);
        }
        if (!group.reviewItemIds.includes(position.activeReviewItemId)) {
          throw new Error(
            `walkthrough item ${position.activeReviewItemId} is not in group ${position.activeGroupId}`
          );
        }
        const storyOrder = insights.groups.flatMap((candidate) => candidate.reviewItemIds);
        const nextIndex = storyOrder.indexOf(position.activeReviewItemId);
        const currentIndex = current.activeReviewItemId ? storyOrder.indexOf(current.activeReviewItemId) : -1;
        if (nextIndex <= currentIndex) return current;
        const next = {
          ...current,
          activeGroupId: position.activeGroupId,
          activeReviewItemId: position.activeReviewItemId,
          ...position.activeFile === void 0 ? {} : { activeFile: position.activeFile },
          updatedAt: nextProgressUpdatedAt(current.updatedAt, options.now?.() ?? Date.now())
        };
        assertReviewProgress(next);
        const workspace = this.readWorkspace(workspaceId);
        validateRevisionRelationships(
          { ...workspace, source: snapshot.source, currentRevisionId: revisionId },
          snapshot,
          insights,
          next,
          finalized !== void 0
        );
        publishProgress(projectRoot, workspaceId, revisionId, finalized, next, options);
        return next;
      });
    },
    setActiveReview(workspaceId, revisionId) {
      return withLock(workspaceId, () => {
        this.readBundle(workspaceId, revisionId);
        const pointer = {
          schemaVersion: 1,
          workspaceId,
          revisionId,
          updatedAt: new Date(options.now?.() ?? Date.now()).toISOString()
        };
        atomicWriteJson(join6(projectRoot, ".synergy", "active-review.json"), pointer);
        return pointer;
      });
    }
  };
}
export {
  RELOCATING_REMOVAL_REASONS,
  ReviewCoreError,
  ReviewFreshnessAsyncError,
  SAFE_SEGMENT,
  answersDir,
  applyCodeSections,
  assertReviewAnswer,
  assertReviewInsights,
  assertReviewProgress,
  assertReviewQuestion,
  assertReviewQuestionEnvelope,
  assertReviewQuestionGeneration,
  assertReviewSnapshot,
  assertReviewWorkspace,
  assertSafeReviewSegment,
  atomicWriteJson,
  buildDiffSnapshot,
  buildRemovalStrips,
  buildScopeSnapshot,
  capturePr,
  captureReviewSource,
  captureScope,
  captureStaged,
  captureUnstaged,
  claimQuestion,
  claimQuestions,
  compareReviewSourceFreshness,
  compareReviewSourceFreshnessAsync,
  createHunkReviewItem,
  createQuestionQueue,
  createReviewStore,
  deriveRemovalRuns,
  deriveReviewReadiness,
  deriveSnapshotRemovalRuns,
  enqueueQuestion,
  excludePathspecs,
  failQuestion,
  formatReviewRef,
  hashText,
  insightsFile,
  isPathExcluded,
  isReviewCoreError,
  listQuestions,
  normalizeExcludePattern,
  normalizeExcludes,
  normalizeExcludesOrUndefined,
  parseReviewRef,
  parseUnifiedDiff,
  progressFile,
  questionsDir,
  recaptureReviewSource,
  reconcileExpiredQuestions,
  reconcileReview,
  reconciliationKey,
  releaseClaim,
  removalRunHash,
  removeReviewListener,
  renewClaim,
  repositoryName,
  resolveRemovalTarget,
  resolveRepositoryRoot,
  resolveReviewItemContext,
  resolveReviewLineSelection,
  reviewAnswerSchema,
  reviewInsightsSchema,
  reviewProgressSchema,
  reviewQuestionEnvelopeSchema,
  reviewQuestionGenerationSchema,
  reviewQuestionSchema,
  reviewQuestionsDirectory,
  reviewRevisionDir,
  reviewSnapshotSchema,
  reviewWorkspaceDir,
  reviewWorkspaceSchema,
  reviewsDir,
  snapshotFile,
  systemCommandRunner,
  touchReviewListener,
  workspaceFile,
  writeAnswer
};
//# sourceMappingURL=index.js.map