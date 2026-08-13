import { X as ReviewSource, $ as SourceFile, o as ReviewBundle, W as ReviewSnapshot, H as ReviewProgress, r as ReviewFileInsight, f as RemovalRationale, v as ReviewItem, w as ReviewItemContext, G as ReviewLineSelection, e as DiffReviewSnapshot, b as DiffHunk, D as DiffFile, Z as ScopeReviewSnapshot, T as ReviewRef, m as ReviewAnswer, u as ReviewInsights, J as ReviewQuestion, K as ReviewQuestionEnvelope, L as ReviewQuestionGeneration, Y as ReviewWorkspace, U as ReviewRepository, I as ReviewProgressUpdate, B as ReviewItemProgressPatch, a1 as WalkthroughPosition, A as ActiveReviewPointer, M as ReviewQuestionGenerationState, C as ClaimResult, Q as QuestionQueue, N as ReviewQuestionInput } from './removals-CPxMhilh.js';
export { a as DiffFileStatus, c as DiffLine, d as DiffLineKind, R as RELOCATING_REMOVAL_REASONS, g as RemovalReason, h as RemovalRun, i as RemovalRunRef, j as RemovalStrip, k as RemovalTargetExcerpt, l as ResolvedRemovalTarget, n as ReviewAnswerReference, p as ReviewClaim, q as ReviewDiffLineRow, s as ReviewGroup, t as ReviewInsightConfidence, x as ReviewItemInsight, y as ReviewItemKind, z as ReviewItemProgress, E as ReviewItemStatus, F as ReviewLineRow, O as ReviewQuestionStatus, P as ReviewRange, S as ReviewReadiness, V as ReviewScopeLineRow, _ as SnapshotRemovalRun, a0 as SourceLine, a2 as buildRemovalStrips, a3 as deriveRemovalRuns, a4 as deriveReviewReadiness, a5 as deriveSnapshotRemovalRuns, a6 as resolveRemovalTarget } from './removals-CPxMhilh.js';

declare function atomicWriteJson(path: string, value: unknown): void;

type ReviewCoreErrorCode = 'review_not_found' | 'review_conflict' | 'review_corrupt' | 'review_busy' | 'review_internal';
/** A stable, safe error code for callers that need to map storage failures. */
declare class ReviewCoreError extends Error {
    readonly code: ReviewCoreErrorCode;
    constructor(code: ReviewCoreErrorCode, message: string);
}
declare function isReviewCoreError(error: unknown): error is ReviewCoreError;

/** Returns a stable SHA-256 digest for persisted review identities. */
declare function hashText(text: string): string;

interface CommandResult {
    exitCode: number;
    stdout: string | Buffer;
    stderr: string;
}
interface CommandRunner {
    run(command: string, args: readonly string[], options: {
        cwd: string;
    }): CommandResult;
}
interface CaptureFileOptions {
    root: string;
    runner?: CommandRunner;
    readFile?: (path: string) => string;
    /** Repository-relative path patterns to keep out of the capture entirely. */
    excludes?: string[];
}
interface CapturePrOptions extends CaptureFileOptions {
    selector: string;
}
interface CaptureScopeOptions extends CaptureFileOptions {
    patterns: string[];
}
type ReviewCaptureSourceRequest = {
    kind: 'pr';
    selector: string;
    excludes?: string[];
} | {
    kind: 'staged';
    excludes?: string[];
} | {
    kind: 'unstaged';
    excludes?: string[];
} | {
    kind: 'scope';
    patterns: string[];
    excludes?: string[];
};
interface CaptureReviewSourceRequest extends CaptureFileOptions {
    source: ReviewCaptureSourceRequest;
}
interface CapturedReviewSource {
    source: ReviewSource;
    fingerprint: string;
    eligiblePaths: string[];
    patch?: string;
    files?: SourceFile[];
    title?: string;
    fingerprintContent?: string;
}
interface ReviewSourceFreshness {
    sourceChanged: boolean;
    captureFailed: boolean;
}
declare const systemCommandRunner: CommandRunner;
declare function capturePr(options: CapturePrOptions): CapturedReviewSource;
declare function captureStaged(options: CaptureFileOptions): CapturedReviewSource;
declare function captureUnstaged(options: CaptureFileOptions): CapturedReviewSource;
declare function captureScope(options: CaptureScopeOptions): CapturedReviewSource;
declare function captureReviewSource(request: CaptureReviewSourceRequest): CapturedReviewSource;
/** Re-captures the exact source selector stored in an immutable snapshot. */
declare function recaptureReviewSource(source: ReviewSource, root: string, dependencies?: Omit<CaptureFileOptions, 'root'>): CapturedReviewSource;
/**
 * Compares a current capture to an immutable source fingerprint. Capture failures fail closed:
 * callers must not report review readiness when current source cannot be proven unchanged.
 */
declare function compareReviewSourceFreshness(snapshot: Pick<CapturedReviewSource, 'source' | 'fingerprint'>, root: string, dependencies?: Omit<CaptureFileOptions, 'root'>): ReviewSourceFreshness;
declare function resolveRepositoryRoot(root: string, runner?: CommandRunner): string;
declare function repositoryName(root: string): string;

type ReviewFreshnessAsyncErrorCode = 'freshness_aborted' | 'freshness_timeout' | 'freshness_worker_failed';
declare class ReviewFreshnessAsyncError extends Error {
    readonly code: ReviewFreshnessAsyncErrorCode;
    constructor(code: ReviewFreshnessAsyncErrorCode);
}
interface ReviewFreshnessWorkerData {
    snapshot: Pick<CapturedReviewSource, 'source' | 'fingerprint'>;
    root: string;
}
interface ReviewFreshnessWorker {
    onMessage(listener: (message: unknown) => void): void;
    onError(listener: (error: Error) => void): void;
    onExit(listener: (code: number) => void): void;
    terminate(): void;
}
interface ReviewFreshnessWorkerInput {
    url: URL;
    data: ReviewFreshnessWorkerData;
}
type ReviewFreshnessWorkerFactory = (input: ReviewFreshnessWorkerInput) => ReviewFreshnessWorker;
interface ReviewSourceFreshnessAsyncOptions {
    timeoutMs?: number;
    signal?: AbortSignal;
    workerFactory?: ReviewFreshnessWorkerFactory;
}
/** Runs the canonical synchronous capture authority outside the caller's event loop. */
declare function compareReviewSourceFreshnessAsync(snapshot: Pick<CapturedReviewSource, 'source' | 'fingerprint'>, root: string, options?: ReviewSourceFreshnessAsyncOptions): Promise<ReviewSourceFreshness>;

interface ReviewReconciliation extends ReviewProgress {
    /** File- and removal-level insights carried into the next revision alongside the reconciled
     * progress. */
    insights: {
        files?: ReviewFileInsight[];
        removals?: RemovalRationale[];
    };
}
/** Creates a stable identity for carry-forward matching independent of line offsets. */
declare function reconciliationKey(item: ReviewItem): string;
/**
 * Derives mutable progress for a new immutable snapshot without changing the prior revision.
 */
declare function reconcileReview(previous: ReviewBundle, currentSnapshot: ReviewSnapshot, now: string): ReviewReconciliation;

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
 */
/** Trims, strips a leading `./`, and collapses trailing slashes so directory forms collapse. */
declare function normalizeExcludePattern(raw: string): string;
/** Normalizes, dedupes, and sorts a set of exclude patterns so equivalent input is identical. */
declare function normalizeExcludes(patterns: readonly string[]): string[];
/** Normalizes excludes, returning `undefined` for an empty/absent set (preserves optionality). */
declare function normalizeExcludesOrUndefined(patterns: readonly string[] | undefined): string[] | undefined;
/** True when `path` (repository-relative) matches any normalized exclude pattern. */
declare function isPathExcluded(path: string, excludes: readonly string[]): boolean;
/**
 * Builds git pathspec arguments that exclude each pattern exactly and everything nested
 * beneath it. Safe to append to any `git diff`/`git ls-files` invocation.
 */
declare function excludePathspecs(excludes: readonly string[]): string[];

/** Resolves one item's complete canonical immutable line context. */
declare function resolveReviewItemContext(snapshot: ReviewSnapshot, reviewItemId: string): ReviewItemContext;
/** Validates exact opaque row IDs against one immutable review item. */
declare function resolveReviewLineSelection(snapshot: ReviewSnapshot, reviewItemId: string, selectedLineIds: readonly string[]): ReviewLineSelection;

interface BuildDiffSnapshotInput {
    revisionId: string;
    predecessorRevisionId?: string;
    source: ReviewSource;
    fingerprint: string;
    createdAt: string;
    patch: string;
}
/** Parses a Git unified patch into repository-relative file and line state. */
declare function parseUnifiedDiff(patch: string): DiffFile[];
declare function createHunkReviewItem(path: string, hunk: DiffHunk): ReviewItem;
declare function buildDiffSnapshot(input: BuildDiffSnapshotInput): DiffReviewSnapshot;

interface BuildScopeSnapshotInput {
    revisionId: string;
    predecessorRevisionId?: string;
    source: ReviewSource;
    fingerprint: string;
    createdAt: string;
    files: SourceFile[];
}
interface ProposedCodeSection {
    path: string;
    label: string;
    start: number;
    end: number;
    parentLabel?: string;
}
declare function buildScopeSnapshot(input: BuildScopeSnapshotInput): ScopeReviewSnapshot;
declare function applyCodeSections(snapshot: ScopeReviewSnapshot, proposed: ProposedCodeSection[]): ScopeReviewSnapshot;

declare const SAFE_SEGMENT: RegExp;
declare function assertSafeReviewSegment(value: string, label: 'workspace' | 'revision' | 'question' | 'answer' | 'listener' | 'claim token'): void;
declare function formatReviewRef(workspaceId: string, revisionId: string): string;
declare function parseReviewRef(value: string): ReviewRef;

declare function reviewsDir(projectRoot: string): string;
declare function reviewWorkspaceDir(projectRoot: string, workspaceId: string): string;
declare function reviewRevisionDir(projectRoot: string, workspaceId: string, revisionId: string): string;
declare function workspaceFile(projectRoot: string, workspaceId: string): string;
declare function snapshotFile(projectRoot: string, workspaceId: string, revisionId: string): string;
declare function insightsFile(projectRoot: string, workspaceId: string, revisionId: string): string;
declare function progressFile(projectRoot: string, workspaceId: string, revisionId: string): string;
declare function questionsDir(projectRoot: string, workspaceId: string, revisionId: string): string;
declare function answersDir(projectRoot: string, workspaceId: string, revisionId: string): string;

declare const reviewWorkspaceSchema: {
    readonly type: "object";
    readonly required: readonly ["schemaVersion", "id", "repository", "source", "currentRevisionId", "createdAt", "updatedAt"];
    readonly additionalProperties: false;
    readonly properties: {
        readonly schemaVersion: {
            readonly const: 1;
        };
        readonly id: {
            readonly type: "string";
            readonly minLength: 1;
        };
        readonly repository: {
            readonly type: "object";
            readonly required: readonly ["root", "name"];
            readonly additionalProperties: false;
            readonly properties: {
                readonly root: {
                    readonly type: "string";
                    readonly minLength: 1;
                };
                readonly name: {
                    readonly type: "string";
                    readonly minLength: 1;
                };
                readonly remoteUrl: {
                    readonly type: "string";
                };
            };
        };
        readonly source: {
            readonly oneOf: readonly [{
                readonly type: "object";
                readonly required: readonly ["kind", "number", "url", "baseSha", "headSha"];
                readonly additionalProperties: false;
                readonly properties: {
                    readonly kind: {
                        readonly const: "pr";
                    };
                    readonly number: {
                        readonly type: "integer";
                        readonly minimum: 1;
                    };
                    readonly url: {
                        readonly type: "string";
                        readonly minLength: 1;
                    };
                    readonly baseSha: {
                        readonly type: "string";
                        readonly minLength: 1;
                    };
                    readonly headSha: {
                        readonly type: "string";
                        readonly minLength: 1;
                    };
                    readonly excludes: {
                        readonly type: "array";
                        readonly items: {
                            readonly type: "string";
                            readonly minLength: 1;
                        };
                    };
                };
            }, {
                readonly type: "object";
                readonly required: readonly ["kind", "headSha"];
                readonly additionalProperties: false;
                readonly properties: {
                    readonly kind: {
                        readonly const: "staged";
                    };
                    readonly headSha: {
                        readonly type: "string";
                        readonly minLength: 1;
                    };
                    readonly excludes: {
                        readonly type: "array";
                        readonly items: {
                            readonly type: "string";
                            readonly minLength: 1;
                        };
                    };
                };
            }, {
                readonly type: "object";
                readonly required: readonly ["kind", "headSha"];
                readonly additionalProperties: false;
                readonly properties: {
                    readonly kind: {
                        readonly const: "unstaged";
                    };
                    readonly headSha: {
                        readonly type: "string";
                        readonly minLength: 1;
                    };
                    readonly excludes: {
                        readonly type: "array";
                        readonly items: {
                            readonly type: "string";
                            readonly minLength: 1;
                        };
                    };
                };
            }, {
                readonly type: "object";
                readonly required: readonly ["kind", "patterns", "headSha"];
                readonly additionalProperties: false;
                readonly properties: {
                    readonly kind: {
                        readonly const: "scope";
                    };
                    readonly patterns: {
                        readonly type: "array";
                        readonly minItems: 1;
                        readonly items: {
                            readonly type: "string";
                            readonly minLength: 1;
                        };
                    };
                    readonly headSha: {
                        readonly type: "string";
                        readonly minLength: 1;
                    };
                    readonly excludes: {
                        readonly type: "array";
                        readonly items: {
                            readonly type: "string";
                            readonly minLength: 1;
                        };
                    };
                };
            }];
        };
        readonly currentRevisionId: {
            readonly type: "string";
            readonly minLength: 1;
        };
        readonly createdAt: {
            readonly type: "string";
            readonly minLength: 1;
        };
        readonly updatedAt: {
            readonly type: "string";
            readonly minLength: 1;
        };
    };
};
declare const reviewSnapshotSchema: {
    readonly oneOf: readonly [{
        readonly type: "object";
        readonly required: readonly ["schemaVersion", "revisionId", "source", "fingerprint", "createdAt", "items", "kind", "files"];
        readonly additionalProperties: false;
        readonly properties: {
            readonly kind: {
                readonly const: "diff";
            };
            readonly files: {
                readonly type: "array";
                readonly items: {
                    readonly type: "object";
                    readonly required: readonly ["path", "status", "additions", "deletions", "binary", "hunks"];
                    readonly additionalProperties: false;
                    readonly properties: {
                        readonly reviewItemId: {
                            readonly type: "string";
                            readonly minLength: 1;
                        };
                        readonly reviewItemContentHash: {
                            readonly type: "string";
                            readonly minLength: 1;
                        };
                        readonly reviewItemLocationHash: {
                            readonly type: "string";
                            readonly minLength: 1;
                        };
                        readonly path: {
                            readonly type: "string";
                            readonly minLength: 1;
                        };
                        readonly previousPath: {
                            readonly type: "string";
                            readonly minLength: 1;
                        };
                        readonly oldMode: {
                            readonly type: "string";
                            readonly minLength: 1;
                        };
                        readonly newMode: {
                            readonly type: "string";
                            readonly minLength: 1;
                        };
                        readonly binaryPatchHash: {
                            readonly type: "string";
                            readonly minLength: 1;
                        };
                        readonly status: {
                            readonly enum: readonly ["added", "deleted", "modified", "renamed", "copied", "binary"];
                        };
                        readonly additions: {
                            readonly type: "integer";
                            readonly minimum: 0;
                        };
                        readonly deletions: {
                            readonly type: "integer";
                            readonly minimum: 0;
                        };
                        readonly binary: {
                            readonly type: "boolean";
                        };
                        readonly hunks: {
                            readonly type: "array";
                            readonly items: {
                                readonly type: "object";
                                readonly required: readonly ["reviewItemId", "reviewItemContentHash", "reviewItemLocationHash", "header", "oldStart", "oldLines", "newStart", "newLines", "lines"];
                                readonly additionalProperties: false;
                                readonly properties: {
                                    readonly reviewItemId: {
                                        readonly type: "string";
                                        readonly minLength: 1;
                                    };
                                    readonly reviewItemContentHash: {
                                        readonly type: "string";
                                        readonly minLength: 1;
                                    };
                                    readonly reviewItemLocationHash: {
                                        readonly type: "string";
                                        readonly minLength: 1;
                                    };
                                    readonly header: {
                                        readonly type: "string";
                                        readonly minLength: 1;
                                    };
                                    readonly oldStart: {
                                        readonly type: "integer";
                                        readonly minimum: 0;
                                    };
                                    readonly oldLines: {
                                        readonly type: "integer";
                                        readonly minimum: 0;
                                    };
                                    readonly newStart: {
                                        readonly type: "integer";
                                        readonly minimum: 0;
                                    };
                                    readonly newLines: {
                                        readonly type: "integer";
                                        readonly minimum: 0;
                                    };
                                    readonly lines: {
                                        readonly type: "array";
                                        readonly items: {
                                            readonly type: "object";
                                            readonly required: readonly ["kind", "text", "oldLine", "newLine"];
                                            readonly additionalProperties: false;
                                            readonly properties: {
                                                readonly kind: {
                                                    readonly enum: readonly ["context", "add", "remove"];
                                                };
                                                readonly text: {
                                                    readonly type: "string";
                                                };
                                                readonly oldLine: {
                                                    readonly type: readonly ["integer", "null"];
                                                    readonly minimum: 1;
                                                };
                                                readonly newLine: {
                                                    readonly type: readonly ["integer", "null"];
                                                    readonly minimum: 1;
                                                };
                                                readonly noNewlineAtEnd: {
                                                    readonly type: "boolean";
                                                };
                                            };
                                        };
                                    };
                                };
                            };
                        };
                    };
                };
            };
            readonly schemaVersion: {
                readonly const: 1;
            };
            readonly revisionId: {
                readonly type: "string";
                readonly minLength: 1;
            };
            readonly predecessorRevisionId: {
                readonly type: "string";
                readonly pattern: string;
            };
            readonly source: {
                readonly oneOf: readonly [{
                    readonly type: "object";
                    readonly required: readonly ["kind", "number", "url", "baseSha", "headSha"];
                    readonly additionalProperties: false;
                    readonly properties: {
                        readonly kind: {
                            readonly const: "pr";
                        };
                        readonly number: {
                            readonly type: "integer";
                            readonly minimum: 1;
                        };
                        readonly url: {
                            readonly type: "string";
                            readonly minLength: 1;
                        };
                        readonly baseSha: {
                            readonly type: "string";
                            readonly minLength: 1;
                        };
                        readonly headSha: {
                            readonly type: "string";
                            readonly minLength: 1;
                        };
                        readonly excludes: {
                            readonly type: "array";
                            readonly items: {
                                readonly type: "string";
                                readonly minLength: 1;
                            };
                        };
                    };
                }, {
                    readonly type: "object";
                    readonly required: readonly ["kind", "headSha"];
                    readonly additionalProperties: false;
                    readonly properties: {
                        readonly kind: {
                            readonly const: "staged";
                        };
                        readonly headSha: {
                            readonly type: "string";
                            readonly minLength: 1;
                        };
                        readonly excludes: {
                            readonly type: "array";
                            readonly items: {
                                readonly type: "string";
                                readonly minLength: 1;
                            };
                        };
                    };
                }, {
                    readonly type: "object";
                    readonly required: readonly ["kind", "headSha"];
                    readonly additionalProperties: false;
                    readonly properties: {
                        readonly kind: {
                            readonly const: "unstaged";
                        };
                        readonly headSha: {
                            readonly type: "string";
                            readonly minLength: 1;
                        };
                        readonly excludes: {
                            readonly type: "array";
                            readonly items: {
                                readonly type: "string";
                                readonly minLength: 1;
                            };
                        };
                    };
                }, {
                    readonly type: "object";
                    readonly required: readonly ["kind", "patterns", "headSha"];
                    readonly additionalProperties: false;
                    readonly properties: {
                        readonly kind: {
                            readonly const: "scope";
                        };
                        readonly patterns: {
                            readonly type: "array";
                            readonly minItems: 1;
                            readonly items: {
                                readonly type: "string";
                                readonly minLength: 1;
                            };
                        };
                        readonly headSha: {
                            readonly type: "string";
                            readonly minLength: 1;
                        };
                        readonly excludes: {
                            readonly type: "array";
                            readonly items: {
                                readonly type: "string";
                                readonly minLength: 1;
                            };
                        };
                    };
                }];
            };
            readonly fingerprint: {
                readonly type: "string";
                readonly minLength: 1;
            };
            readonly createdAt: {
                readonly type: "string";
                readonly minLength: 1;
            };
            readonly items: {
                readonly type: "array";
                readonly items: {
                    readonly type: "object";
                    readonly required: readonly ["id", "kind", "path", "label", "range", "contentHash", "locationHash"];
                    readonly additionalProperties: false;
                    readonly properties: {
                        readonly id: {
                            readonly type: "string";
                            readonly minLength: 1;
                        };
                        readonly kind: {
                            readonly enum: readonly ["hunk", "code-section", "file"];
                        };
                        readonly path: {
                            readonly type: "string";
                            readonly minLength: 1;
                        };
                        readonly label: {
                            readonly type: "string";
                            readonly minLength: 1;
                        };
                        readonly range: {
                            readonly type: "object";
                            readonly required: readonly ["start", "end"];
                            readonly additionalProperties: false;
                            readonly properties: {
                                readonly start: {
                                    readonly type: "integer";
                                    readonly minimum: 1;
                                };
                                readonly end: {
                                    readonly type: "integer";
                                    readonly minimum: 1;
                                };
                            };
                        };
                        readonly contentHash: {
                            readonly type: "string";
                            readonly minLength: 1;
                        };
                        readonly locationHash: {
                            readonly type: "string";
                            readonly minLength: 1;
                        };
                    };
                };
            };
        };
    }, {
        readonly type: "object";
        readonly required: readonly ["schemaVersion", "revisionId", "source", "fingerprint", "createdAt", "items", "kind", "files"];
        readonly additionalProperties: false;
        readonly properties: {
            readonly kind: {
                readonly const: "scope";
            };
            readonly files: {
                readonly type: "array";
                readonly items: {
                    readonly type: "object";
                    readonly required: readonly ["path", "lines", "binary"];
                    readonly additionalProperties: false;
                    readonly properties: {
                        readonly path: {
                            readonly type: "string";
                            readonly minLength: 1;
                        };
                        readonly binary: {
                            readonly type: "boolean";
                        };
                        readonly lines: {
                            readonly type: "array";
                            readonly items: {
                                readonly type: "object";
                                readonly required: readonly ["number", "text"];
                                readonly additionalProperties: false;
                                readonly properties: {
                                    readonly number: {
                                        readonly type: "integer";
                                        readonly minimum: 1;
                                    };
                                    readonly text: {
                                        readonly type: "string";
                                    };
                                };
                            };
                        };
                    };
                };
            };
            readonly schemaVersion: {
                readonly const: 1;
            };
            readonly revisionId: {
                readonly type: "string";
                readonly minLength: 1;
            };
            readonly predecessorRevisionId: {
                readonly type: "string";
                readonly pattern: string;
            };
            readonly source: {
                readonly oneOf: readonly [{
                    readonly type: "object";
                    readonly required: readonly ["kind", "number", "url", "baseSha", "headSha"];
                    readonly additionalProperties: false;
                    readonly properties: {
                        readonly kind: {
                            readonly const: "pr";
                        };
                        readonly number: {
                            readonly type: "integer";
                            readonly minimum: 1;
                        };
                        readonly url: {
                            readonly type: "string";
                            readonly minLength: 1;
                        };
                        readonly baseSha: {
                            readonly type: "string";
                            readonly minLength: 1;
                        };
                        readonly headSha: {
                            readonly type: "string";
                            readonly minLength: 1;
                        };
                        readonly excludes: {
                            readonly type: "array";
                            readonly items: {
                                readonly type: "string";
                                readonly minLength: 1;
                            };
                        };
                    };
                }, {
                    readonly type: "object";
                    readonly required: readonly ["kind", "headSha"];
                    readonly additionalProperties: false;
                    readonly properties: {
                        readonly kind: {
                            readonly const: "staged";
                        };
                        readonly headSha: {
                            readonly type: "string";
                            readonly minLength: 1;
                        };
                        readonly excludes: {
                            readonly type: "array";
                            readonly items: {
                                readonly type: "string";
                                readonly minLength: 1;
                            };
                        };
                    };
                }, {
                    readonly type: "object";
                    readonly required: readonly ["kind", "headSha"];
                    readonly additionalProperties: false;
                    readonly properties: {
                        readonly kind: {
                            readonly const: "unstaged";
                        };
                        readonly headSha: {
                            readonly type: "string";
                            readonly minLength: 1;
                        };
                        readonly excludes: {
                            readonly type: "array";
                            readonly items: {
                                readonly type: "string";
                                readonly minLength: 1;
                            };
                        };
                    };
                }, {
                    readonly type: "object";
                    readonly required: readonly ["kind", "patterns", "headSha"];
                    readonly additionalProperties: false;
                    readonly properties: {
                        readonly kind: {
                            readonly const: "scope";
                        };
                        readonly patterns: {
                            readonly type: "array";
                            readonly minItems: 1;
                            readonly items: {
                                readonly type: "string";
                                readonly minLength: 1;
                            };
                        };
                        readonly headSha: {
                            readonly type: "string";
                            readonly minLength: 1;
                        };
                        readonly excludes: {
                            readonly type: "array";
                            readonly items: {
                                readonly type: "string";
                                readonly minLength: 1;
                            };
                        };
                    };
                }];
            };
            readonly fingerprint: {
                readonly type: "string";
                readonly minLength: 1;
            };
            readonly createdAt: {
                readonly type: "string";
                readonly minLength: 1;
            };
            readonly items: {
                readonly type: "array";
                readonly items: {
                    readonly type: "object";
                    readonly required: readonly ["id", "kind", "path", "label", "range", "contentHash", "locationHash"];
                    readonly additionalProperties: false;
                    readonly properties: {
                        readonly id: {
                            readonly type: "string";
                            readonly minLength: 1;
                        };
                        readonly kind: {
                            readonly enum: readonly ["hunk", "code-section", "file"];
                        };
                        readonly path: {
                            readonly type: "string";
                            readonly minLength: 1;
                        };
                        readonly label: {
                            readonly type: "string";
                            readonly minLength: 1;
                        };
                        readonly range: {
                            readonly type: "object";
                            readonly required: readonly ["start", "end"];
                            readonly additionalProperties: false;
                            readonly properties: {
                                readonly start: {
                                    readonly type: "integer";
                                    readonly minimum: 1;
                                };
                                readonly end: {
                                    readonly type: "integer";
                                    readonly minimum: 1;
                                };
                            };
                        };
                        readonly contentHash: {
                            readonly type: "string";
                            readonly minLength: 1;
                        };
                        readonly locationHash: {
                            readonly type: "string";
                            readonly minLength: 1;
                        };
                    };
                };
            };
        };
    }];
};
declare const reviewInsightsSchema: {
    readonly type: "object";
    readonly required: readonly ["schemaVersion", "revisionId", "groups", "items"];
    readonly additionalProperties: false;
    readonly properties: {
        readonly schemaVersion: {
            readonly const: 1;
        };
        readonly revisionId: {
            readonly type: "string";
            readonly minLength: 1;
        };
        readonly summary: {
            readonly type: "string";
            readonly minLength: 1;
        };
        readonly groups: {
            readonly type: "array";
            readonly items: {
                readonly type: "object";
                readonly required: readonly ["id", "label", "reviewItemIds"];
                readonly additionalProperties: false;
                readonly properties: {
                    readonly id: {
                        readonly type: "string";
                        readonly minLength: 1;
                    };
                    readonly label: {
                        readonly type: "string";
                        readonly minLength: 1;
                    };
                    readonly intro: {
                        readonly type: "string";
                        readonly minLength: 1;
                    };
                    readonly reviewItemIds: {
                        readonly type: "array";
                        readonly items: {
                            readonly type: "string";
                            readonly minLength: 1;
                        };
                    };
                };
            };
        };
        readonly items: {
            readonly type: "array";
            readonly items: {
                readonly type: "object";
                readonly required: readonly ["reviewItemId", "description", "confidence", "evidencePaths"];
                readonly additionalProperties: false;
                readonly properties: {
                    readonly reviewItemId: {
                        readonly type: "string";
                        readonly minLength: 1;
                    };
                    readonly description: {
                        readonly type: "string";
                        readonly minLength: 1;
                    };
                    readonly confidence: {
                        readonly enum: readonly ["high", "medium", "low"];
                    };
                    readonly evidencePaths: {
                        readonly type: "array";
                        readonly items: {
                            readonly type: "string";
                            readonly minLength: 1;
                        };
                    };
                };
            };
        };
        readonly files: {
            readonly type: "array";
            readonly items: {
                readonly type: "object";
                readonly required: readonly ["path", "description", "confidence"];
                readonly additionalProperties: false;
                readonly properties: {
                    readonly path: {
                        readonly type: "string";
                        readonly minLength: 1;
                    };
                    readonly description: {
                        readonly type: "string";
                        readonly minLength: 1;
                    };
                    readonly confidence: {
                        readonly enum: readonly ["high", "medium", "low"];
                    };
                };
            };
        };
        readonly removals: {
            readonly type: "array";
            readonly items: {
                readonly type: "object";
                readonly required: readonly ["reviewItemId", "run", "reason", "description"];
                readonly additionalProperties: false;
                readonly properties: {
                    readonly reviewItemId: {
                        readonly type: "string";
                        readonly minLength: 1;
                    };
                    readonly run: {
                        readonly type: "object";
                        readonly required: readonly ["path", "start", "end"];
                        readonly additionalProperties: false;
                        readonly properties: {
                            readonly path: {
                                readonly type: "string";
                                readonly minLength: 1;
                            };
                            readonly start: {
                                readonly type: "integer";
                                readonly minimum: 1;
                            };
                            readonly end: {
                                readonly type: "integer";
                                readonly minimum: 1;
                            };
                        };
                    };
                    readonly reason: {
                        readonly enum: readonly ["moved", "merged", "replaced", "dead-code", "obsolete", "extracted-to-dep", "unclear"];
                    };
                    readonly description: {
                        readonly type: "string";
                        readonly minLength: 1;
                    };
                    readonly movedTo: {
                        readonly type: "object";
                        readonly required: readonly ["path", "start", "end"];
                        readonly additionalProperties: false;
                        readonly properties: {
                            readonly path: {
                                readonly type: "string";
                                readonly minLength: 1;
                            };
                            readonly start: {
                                readonly type: "integer";
                                readonly minimum: 1;
                            };
                            readonly end: {
                                readonly type: "integer";
                                readonly minimum: 1;
                            };
                        };
                    };
                    readonly movedToExcerpt: {
                        readonly type: "object";
                        readonly required: readonly ["path", "start", "lines"];
                        readonly additionalProperties: false;
                        readonly properties: {
                            readonly path: {
                                readonly type: "string";
                                readonly minLength: 1;
                            };
                            readonly start: {
                                readonly type: "integer";
                                readonly minimum: 1;
                            };
                            readonly lines: {
                                readonly type: "array";
                                readonly items: {
                                    readonly type: "string";
                                };
                            };
                        };
                    };
                };
            };
        };
    };
};
declare const reviewProgressSchema: {
    readonly type: "object";
    readonly required: readonly ["schemaVersion", "updatedAt", "items"];
    readonly additionalProperties: false;
    readonly properties: {
        readonly schemaVersion: {
            readonly const: 1;
        };
        readonly updatedAt: {
            readonly type: "string";
            readonly minLength: 1;
        };
        readonly items: {
            readonly type: "object";
            readonly additionalProperties: {
                readonly type: "object";
                readonly required: readonly ["status"];
                readonly additionalProperties: false;
                readonly properties: {
                    readonly status: {
                        readonly enum: readonly ["needs-review", "reviewed", "carried-forward", "stale"];
                    };
                    readonly note: {
                        readonly type: "string";
                    };
                    readonly reviewedAt: {
                        readonly type: "string";
                        readonly minLength: 1;
                    };
                    readonly inheritedFrom: {
                        readonly type: "object";
                        readonly required: readonly ["revisionId", "reviewItemId"];
                        readonly additionalProperties: false;
                        readonly properties: {
                            readonly revisionId: {
                                readonly type: "string";
                                readonly minLength: 1;
                            };
                            readonly reviewItemId: {
                                readonly type: "string";
                                readonly minLength: 1;
                            };
                        };
                    };
                };
            };
        };
        readonly activeGroupId: {
            readonly type: "string";
            readonly minLength: 1;
        };
        readonly activeFile: {
            readonly type: "string";
            readonly minLength: 1;
        };
        readonly activeReviewItemId: {
            readonly type: "string";
            readonly minLength: 1;
        };
    };
};
declare const reviewQuestionEnvelopeSchema: {
    readonly type: "object";
    readonly required: readonly ["schemaVersion", "id", "workspaceId", "revisionId", "path", "reviewItemId", "selection", "itemContext", "description", "body", "createdAt"];
    readonly additionalProperties: false;
    readonly properties: {
        readonly schemaVersion: {
            readonly const: 1;
        };
        readonly id: {
            readonly type: "string";
            readonly minLength: 1;
        };
        readonly workspaceId: {
            readonly type: "string";
            readonly minLength: 1;
        };
        readonly revisionId: {
            readonly type: "string";
            readonly minLength: 1;
        };
        readonly path: {
            readonly type: "string";
            readonly minLength: 1;
        };
        readonly reviewItemId: {
            readonly type: "string";
            readonly minLength: 1;
        };
        readonly selection: {
            readonly oneOf: readonly [{
                readonly type: "object";
                readonly required: readonly ["kind", "selectedLineIds"];
                readonly additionalProperties: false;
                readonly properties: {
                    readonly kind: {
                        readonly const: "diff";
                    };
                    readonly selectedLineIds: {
                        readonly type: "array";
                        readonly minItems: 1;
                        readonly uniqueItems: true;
                        readonly items: {
                            readonly type: "string";
                            readonly minLength: 1;
                        };
                    };
                };
            }, {
                readonly type: "object";
                readonly required: readonly ["kind", "selectedLineIds"];
                readonly additionalProperties: false;
                readonly properties: {
                    readonly kind: {
                        readonly const: "scope";
                    };
                    readonly selectedLineIds: {
                        readonly type: "array";
                        readonly minItems: 1;
                        readonly uniqueItems: true;
                        readonly items: {
                            readonly type: "string";
                            readonly minLength: 1;
                        };
                    };
                };
            }];
        };
        readonly itemContext: {
            readonly type: "object";
            readonly required: readonly ["item", "rows"];
            readonly additionalProperties: false;
            readonly properties: {
                readonly item: {
                    readonly type: "object";
                    readonly required: readonly ["id", "kind", "path", "label", "range", "contentHash", "locationHash"];
                    readonly additionalProperties: false;
                    readonly properties: {
                        readonly id: {
                            readonly type: "string";
                            readonly minLength: 1;
                        };
                        readonly kind: {
                            readonly enum: readonly ["hunk", "code-section", "file"];
                        };
                        readonly path: {
                            readonly type: "string";
                            readonly minLength: 1;
                        };
                        readonly label: {
                            readonly type: "string";
                            readonly minLength: 1;
                        };
                        readonly range: {
                            readonly type: "object";
                            readonly required: readonly ["start", "end"];
                            readonly additionalProperties: false;
                            readonly properties: {
                                readonly start: {
                                    readonly type: "integer";
                                    readonly minimum: 1;
                                };
                                readonly end: {
                                    readonly type: "integer";
                                    readonly minimum: 1;
                                };
                            };
                        };
                        readonly contentHash: {
                            readonly type: "string";
                            readonly minLength: 1;
                        };
                        readonly locationHash: {
                            readonly type: "string";
                            readonly minLength: 1;
                        };
                    };
                };
                readonly rows: {
                    readonly type: "array";
                    readonly minItems: 1;
                    readonly items: {
                        readonly oneOf: readonly [{
                            readonly type: "object";
                            readonly required: readonly ["id", "kind", "line", "text"];
                            readonly additionalProperties: false;
                            readonly properties: {
                                readonly id: {
                                    readonly type: "string";
                                    readonly minLength: 1;
                                };
                                readonly kind: {
                                    readonly const: "scope";
                                };
                                readonly line: {
                                    readonly type: "integer";
                                    readonly minimum: 1;
                                };
                                readonly text: {
                                    readonly type: "string";
                                };
                            };
                        }, {
                            readonly type: "object";
                            readonly required: readonly ["id", "kind", "oldLine", "newLine", "text"];
                            readonly additionalProperties: false;
                            readonly properties: {
                                readonly id: {
                                    readonly type: "string";
                                    readonly minLength: 1;
                                };
                                readonly kind: {
                                    readonly enum: readonly ["context", "add", "remove"];
                                };
                                readonly oldLine: {
                                    readonly type: readonly ["integer", "null"];
                                    readonly minimum: 1;
                                };
                                readonly newLine: {
                                    readonly type: readonly ["integer", "null"];
                                    readonly minimum: 1;
                                };
                                readonly text: {
                                    readonly type: "string";
                                };
                                readonly noNewlineAtEnd: {
                                    readonly type: "boolean";
                                };
                            };
                        }];
                    };
                };
            };
        };
        readonly description: {
            readonly type: "string";
        };
        readonly body: {
            readonly type: "string";
            readonly minLength: 1;
        };
        readonly createdAt: {
            readonly type: "string";
            readonly minLength: 1;
        };
    };
};
declare const reviewQuestionSchema: {
    readonly type: "object";
    readonly required: readonly ["schemaVersion", "id", "workspaceId", "revisionId", "path", "reviewItemId", "selection", "itemContext", "description", "body", "createdAt", "generation", "status"];
    readonly additionalProperties: false;
    readonly properties: {
        readonly schemaVersion: {
            readonly const: 1;
        };
        readonly id: {
            readonly type: "string";
            readonly minLength: 1;
        };
        readonly workspaceId: {
            readonly type: "string";
            readonly minLength: 1;
        };
        readonly revisionId: {
            readonly type: "string";
            readonly minLength: 1;
        };
        readonly path: {
            readonly type: "string";
            readonly minLength: 1;
        };
        readonly reviewItemId: {
            readonly type: "string";
            readonly minLength: 1;
        };
        readonly selection: {
            readonly oneOf: readonly [{
                readonly type: "object";
                readonly required: readonly ["kind", "selectedLineIds"];
                readonly additionalProperties: false;
                readonly properties: {
                    readonly kind: {
                        readonly const: "diff";
                    };
                    readonly selectedLineIds: {
                        readonly type: "array";
                        readonly minItems: 1;
                        readonly uniqueItems: true;
                        readonly items: {
                            readonly type: "string";
                            readonly minLength: 1;
                        };
                    };
                };
            }, {
                readonly type: "object";
                readonly required: readonly ["kind", "selectedLineIds"];
                readonly additionalProperties: false;
                readonly properties: {
                    readonly kind: {
                        readonly const: "scope";
                    };
                    readonly selectedLineIds: {
                        readonly type: "array";
                        readonly minItems: 1;
                        readonly uniqueItems: true;
                        readonly items: {
                            readonly type: "string";
                            readonly minLength: 1;
                        };
                    };
                };
            }];
        };
        readonly itemContext: {
            readonly type: "object";
            readonly required: readonly ["item", "rows"];
            readonly additionalProperties: false;
            readonly properties: {
                readonly item: {
                    readonly type: "object";
                    readonly required: readonly ["id", "kind", "path", "label", "range", "contentHash", "locationHash"];
                    readonly additionalProperties: false;
                    readonly properties: {
                        readonly id: {
                            readonly type: "string";
                            readonly minLength: 1;
                        };
                        readonly kind: {
                            readonly enum: readonly ["hunk", "code-section", "file"];
                        };
                        readonly path: {
                            readonly type: "string";
                            readonly minLength: 1;
                        };
                        readonly label: {
                            readonly type: "string";
                            readonly minLength: 1;
                        };
                        readonly range: {
                            readonly type: "object";
                            readonly required: readonly ["start", "end"];
                            readonly additionalProperties: false;
                            readonly properties: {
                                readonly start: {
                                    readonly type: "integer";
                                    readonly minimum: 1;
                                };
                                readonly end: {
                                    readonly type: "integer";
                                    readonly minimum: 1;
                                };
                            };
                        };
                        readonly contentHash: {
                            readonly type: "string";
                            readonly minLength: 1;
                        };
                        readonly locationHash: {
                            readonly type: "string";
                            readonly minLength: 1;
                        };
                    };
                };
                readonly rows: {
                    readonly type: "array";
                    readonly minItems: 1;
                    readonly items: {
                        readonly oneOf: readonly [{
                            readonly type: "object";
                            readonly required: readonly ["id", "kind", "line", "text"];
                            readonly additionalProperties: false;
                            readonly properties: {
                                readonly id: {
                                    readonly type: "string";
                                    readonly minLength: 1;
                                };
                                readonly kind: {
                                    readonly const: "scope";
                                };
                                readonly line: {
                                    readonly type: "integer";
                                    readonly minimum: 1;
                                };
                                readonly text: {
                                    readonly type: "string";
                                };
                            };
                        }, {
                            readonly type: "object";
                            readonly required: readonly ["id", "kind", "oldLine", "newLine", "text"];
                            readonly additionalProperties: false;
                            readonly properties: {
                                readonly id: {
                                    readonly type: "string";
                                    readonly minLength: 1;
                                };
                                readonly kind: {
                                    readonly enum: readonly ["context", "add", "remove"];
                                };
                                readonly oldLine: {
                                    readonly type: readonly ["integer", "null"];
                                    readonly minimum: 1;
                                };
                                readonly newLine: {
                                    readonly type: readonly ["integer", "null"];
                                    readonly minimum: 1;
                                };
                                readonly text: {
                                    readonly type: "string";
                                };
                                readonly noNewlineAtEnd: {
                                    readonly type: "boolean";
                                };
                            };
                        }];
                    };
                };
            };
        };
        readonly description: {
            readonly type: "string";
        };
        readonly body: {
            readonly type: "string";
            readonly minLength: 1;
        };
        readonly createdAt: {
            readonly type: "string";
            readonly minLength: 1;
        };
        readonly generation: {
            readonly type: "integer";
            readonly minimum: 0;
        };
        readonly status: {
            readonly enum: readonly ["queued", "processing", "answered", "failed", "stale"];
        };
        readonly claim: {
            readonly type: "object";
            readonly required: readonly ["listenerId", "token", "claimedAt", "expiresAt"];
            readonly additionalProperties: false;
            readonly properties: {
                readonly listenerId: {
                    readonly type: "string";
                    readonly minLength: 1;
                };
                readonly token: {
                    readonly type: "string";
                    readonly pattern: string;
                };
                readonly claimedAt: {
                    readonly type: "string";
                    readonly minLength: 1;
                };
                readonly expiresAt: {
                    readonly type: "string";
                    readonly minLength: 1;
                };
            };
        };
        readonly failureMessage: {
            readonly type: "string";
        };
    };
};
declare const reviewQuestionGenerationSchema: {
    readonly type: "object";
    readonly required: readonly ["schemaVersion", "questionId", "workspaceId", "revisionId", "generation", "predecessorGeneration", "predecessorHash", "envelopeHash", "state", "publishedAt"];
    readonly additionalProperties: false;
    readonly properties: {
        readonly schemaVersion: {
            readonly const: 1;
        };
        readonly questionId: {
            readonly type: "string";
            readonly minLength: 1;
        };
        readonly workspaceId: {
            readonly type: "string";
            readonly minLength: 1;
        };
        readonly revisionId: {
            readonly type: "string";
            readonly minLength: 1;
        };
        readonly generation: {
            readonly type: "integer";
            readonly minimum: 0;
        };
        readonly predecessorGeneration: {
            readonly type: readonly ["integer", "null"];
            readonly minimum: 0;
        };
        readonly predecessorHash: {
            readonly type: readonly ["string", "null"];
            readonly minLength: 1;
        };
        readonly envelopeHash: {
            readonly type: "string";
            readonly minLength: 1;
        };
        readonly state: {
            readonly enum: readonly ["queued", "claimed", "answer-pending", "answered", "failed", "stale"];
        };
        readonly publishedAt: {
            readonly type: "string";
            readonly minLength: 1;
        };
        readonly claim: {
            readonly type: "object";
            readonly required: readonly ["listenerId", "token", "claimedAt", "expiresAt"];
            readonly additionalProperties: false;
            readonly properties: {
                readonly listenerId: {
                    readonly type: "string";
                    readonly minLength: 1;
                };
                readonly token: {
                    readonly type: "string";
                    readonly pattern: string;
                };
                readonly claimedAt: {
                    readonly type: "string";
                    readonly minLength: 1;
                };
                readonly expiresAt: {
                    readonly type: "string";
                    readonly minLength: 1;
                };
            };
        };
        readonly answer: {
            readonly type: "object";
            readonly required: readonly ["id", "listenerId", "bodyHash", "createdAt"];
            readonly additionalProperties: false;
            readonly properties: {
                readonly id: {
                    readonly type: "string";
                    readonly pattern: string;
                };
                readonly listenerId: {
                    readonly type: "string";
                    readonly minLength: 1;
                };
                readonly bodyHash: {
                    readonly type: "string";
                    readonly minLength: 1;
                };
                readonly createdAt: {
                    readonly type: "string";
                    readonly minLength: 1;
                };
            };
        };
        readonly failureMessage: {
            readonly type: "string";
            readonly minLength: 1;
        };
    };
};
declare const reviewAnswerSchema: {
    readonly type: "object";
    readonly required: readonly ["schemaVersion", "id", "questionId", "workspaceId", "revisionId", "listenerId", "body", "createdAt"];
    readonly additionalProperties: false;
    readonly properties: {
        readonly schemaVersion: {
            readonly const: 1;
        };
        readonly id: {
            readonly type: "string";
            readonly minLength: 1;
        };
        readonly questionId: {
            readonly type: "string";
            readonly minLength: 1;
        };
        readonly workspaceId: {
            readonly type: "string";
            readonly minLength: 1;
        };
        readonly revisionId: {
            readonly type: "string";
            readonly minLength: 1;
        };
        readonly listenerId: {
            readonly type: "string";
            readonly minLength: 1;
        };
        readonly body: {
            readonly type: "string";
            readonly minLength: 1;
        };
        readonly createdAt: {
            readonly type: "string";
            readonly minLength: 1;
        };
    };
};
declare function assertReviewWorkspace(value: unknown): asserts value is ReviewWorkspace;
declare function assertReviewSnapshot(value: unknown): asserts value is ReviewSnapshot;
declare function assertReviewInsights(value: unknown): asserts value is ReviewInsights;
declare function assertReviewProgress(value: unknown): asserts value is ReviewProgress;
declare function assertReviewQuestion(value: unknown): asserts value is ReviewQuestion;
declare function assertReviewQuestionEnvelope(value: unknown): asserts value is ReviewQuestionEnvelope;
declare function assertReviewQuestionGeneration(value: unknown): asserts value is ReviewQuestionGeneration;
declare function assertReviewAnswer(value: unknown): asserts value is ReviewAnswer;

/**
 * Identity for carry-forward matching: depends only on the ordered removed text, never on line
 * numbers, so a pure offset shift (e.g. an unrelated edit above the run) still matches.
 *
 * Split into its own module (rather than living in `removals.ts`) because it is the only piece
 * of the removal-derivation surface that needs `hashText` (`node:crypto`). `removals.ts` is
 * imported by the browser-safe entry point (`browser.ts`) for the preview app and VS Code
 * webview; those bundlers fail to resolve `node:crypto` even for unused exports, so any
 * node-only import at the top of `removals.ts` would break both hosts. Keeping this one function
 * in its own file keeps `removals.ts` importable from `browser.ts` without pulling in Node
 * built-ins.
 */
declare function removalRunHash(texts: readonly string[]): string;

interface ReviewStore {
    createRevision(workspace: ReviewWorkspace, snapshot: ReviewSnapshot, insights: ReviewInsights, progress: ReviewProgress): void;
    readBundle(workspaceId: string, revisionId: string): ReviewBundle;
    readWorkspace(workspaceId: string): ReviewWorkspace;
    listWorkspaces(): ReviewWorkspace[];
    findRevisionByFingerprint(workspaceId: string, fingerprint: string): string | undefined;
    writeInitialInsights(workspaceId: string, revisionId: string, insights: ReviewInsights, finalizedAt?: string): void;
    finalizeScopeAnalysis(workspaceId: string, revisionId: string, snapshot: ReviewSnapshot, insights: ReviewInsights, progress: ReviewProgress, finalizedAt?: string): void;
    setCurrentRevision(workspaceId: string, revisionId: string, source: ReviewSource, repository?: ReviewRepository): void;
    isAnalysisFinalized(workspaceId: string, revisionId: string): boolean;
    getAnalysisFinalizedAt(workspaceId: string, revisionId: string): string | undefined;
    updateProgress(workspaceId: string, revisionId: string, update: ReviewProgressUpdate): ReviewProgress;
    patchItemProgress(workspaceId: string, revisionId: string, reviewItemId: string, patch: ReviewItemProgressPatch): ReviewProgress;
    patchWalkthroughPosition(workspaceId: string, revisionId: string, position: WalkthroughPosition): ReviewProgress;
    setActiveReview(workspaceId: string, revisionId: string): ActiveReviewPointer;
}
interface ReviewStoreOptions {
    beforeFinalizedBundlePublish?: () => void;
    beforeProgressPublish?: () => void;
    beforeWorkspacePublish?: () => void;
    openLockFile?: (path: string, flags: 'wx') => number;
    closeLockFile?: (descriptor: number) => void;
    isProcessAlive?: (pid: number) => boolean;
    now?: () => number;
}
declare function createReviewStore(projectRoot: string, options?: ReviewStoreOptions): ReviewStore;

interface QuestionPublication {
    kind: 'question' | 'generation' | 'answer';
    path: string;
    questionId: string;
    generation?: number;
    state?: ReviewQuestionGenerationState;
}
interface QuestionPersistenceOptions {
    beforePublish?: (publication: QuestionPublication) => void;
    afterPublish?: (publication: QuestionPublication) => void;
    beforeFileFsync?: (publication: QuestionPublication) => void;
    afterFileFsync?: (publication: QuestionPublication) => void;
    beforeParentDirectoryFsync?: (publication: QuestionPublication) => void;
    afterParentDirectoryFsync?: (publication: QuestionPublication) => void;
    beforeDirectoryFsync?: (publication: QuestionPublication) => void;
    afterDirectoryFsync?: (publication: QuestionPublication) => void;
    link?: (temporary: string, destination: string, publication: QuestionPublication) => void;
    cleanupTemporary?: (temporary: string, publication: QuestionPublication) => void;
}

declare function enqueueQuestion(projectRoot: string, reference: ReviewRef, question: ReviewQuestionInput): ReviewQuestion;
declare function listQuestions(projectRoot: string, reference: ReviewRef): ReviewQuestion[];
declare function reconcileExpiredQuestions(projectRoot: string, reference: ReviewRef, now?: number): ReviewQuestion[];
declare function claimQuestion(projectRoot: string, reference: ReviewRef, questionId: string, listenerId: string, now: number, leaseMs: number): ClaimResult;
declare function claimQuestions(projectRoot: string, reference: ReviewRef, listenerId: string, now: number, leaseMs: number): ReviewQuestion[];
declare function renewClaim(projectRoot: string, reference: ReviewRef, questionId: string, listenerId: string, claimToken: string, now: number, leaseMs: number): ClaimResult;
declare function releaseClaim(projectRoot: string, reference: ReviewRef, questionId: string, listenerId: string, claimToken: string, now: number): boolean;
declare function failQuestion(projectRoot: string, reference: ReviewRef, questionId: string, listenerId: string, claimToken: string, failureMessage: string, now: number): boolean;
declare function writeAnswer(projectRoot: string, reference: ReviewRef, questionId: string, listenerId: string, claimToken: string, body: string, now: number): ReviewAnswer;
declare function touchReviewListener(projectRoot: string, reference: ReviewRef, listenerId: string, now?: number): void;
declare function removeReviewListener(projectRoot: string, reference: ReviewRef, listenerId: string): void;
declare function createQuestionQueue(projectRoot: string, reference: ReviewRef, options?: QuestionPersistenceOptions): QuestionQueue;
declare function reviewQuestionsDirectory(projectRoot: string, reference: ReviewRef): string;

export { ActiveReviewPointer, type BuildDiffSnapshotInput, type BuildScopeSnapshotInput, type CaptureFileOptions, type CapturePrOptions, type CaptureReviewSourceRequest, type CaptureScopeOptions, type CapturedReviewSource, ClaimResult, type CommandResult, type CommandRunner, DiffFile, DiffHunk, DiffReviewSnapshot, type ProposedCodeSection, type QuestionPersistenceOptions, type QuestionPublication, QuestionQueue, RemovalRationale, ReviewAnswer, ReviewBundle, type ReviewCaptureSourceRequest, ReviewCoreError, type ReviewCoreErrorCode, ReviewFileInsight, ReviewFreshnessAsyncError, type ReviewFreshnessAsyncErrorCode, type ReviewFreshnessWorker, type ReviewFreshnessWorkerData, type ReviewFreshnessWorkerFactory, type ReviewFreshnessWorkerInput, ReviewInsights, ReviewItem, ReviewItemContext, ReviewItemProgressPatch, ReviewLineSelection, ReviewProgress, ReviewProgressUpdate, ReviewQuestion, ReviewQuestionEnvelope, ReviewQuestionGeneration, ReviewQuestionGenerationState, ReviewQuestionInput, ReviewRef, ReviewRepository, ReviewSnapshot, ReviewSource, type ReviewSourceFreshness, type ReviewSourceFreshnessAsyncOptions, type ReviewStore, type ReviewStoreOptions, ReviewWorkspace, SAFE_SEGMENT, ScopeReviewSnapshot, SourceFile, WalkthroughPosition, answersDir, applyCodeSections, assertReviewAnswer, assertReviewInsights, assertReviewProgress, assertReviewQuestion, assertReviewQuestionEnvelope, assertReviewQuestionGeneration, assertReviewSnapshot, assertReviewWorkspace, assertSafeReviewSegment, atomicWriteJson, buildDiffSnapshot, buildScopeSnapshot, capturePr, captureReviewSource, captureScope, captureStaged, captureUnstaged, claimQuestion, claimQuestions, compareReviewSourceFreshness, compareReviewSourceFreshnessAsync, createHunkReviewItem, createQuestionQueue, createReviewStore, enqueueQuestion, excludePathspecs, failQuestion, formatReviewRef, hashText, insightsFile, isPathExcluded, isReviewCoreError, listQuestions, normalizeExcludePattern, normalizeExcludes, normalizeExcludesOrUndefined, parseReviewRef, parseUnifiedDiff, progressFile, questionsDir, recaptureReviewSource, reconcileExpiredQuestions, reconcileReview, reconciliationKey, releaseClaim, removalRunHash, removeReviewListener, renewClaim, repositoryName, resolveRepositoryRoot, resolveReviewItemContext, resolveReviewLineSelection, reviewAnswerSchema, reviewInsightsSchema, reviewProgressSchema, reviewQuestionEnvelopeSchema, reviewQuestionGenerationSchema, reviewQuestionSchema, reviewQuestionsDirectory, reviewRevisionDir, reviewSnapshotSchema, reviewWorkspaceDir, reviewWorkspaceSchema, reviewsDir, snapshotFile, systemCommandRunner, touchReviewListener, workspaceFile, writeAnswer };
