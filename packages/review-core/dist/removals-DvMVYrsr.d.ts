type ReviewSource = {
    kind: 'pr';
    number: number;
    url: string;
    baseSha: string;
    headSha: string;
    /** Normalized, sorted, repository-relative path patterns kept out of the capture. */
    excludes?: string[];
} | {
    kind: 'staged';
    headSha: string;
    excludes?: string[];
} | {
    kind: 'unstaged';
    headSha: string;
    excludes?: string[];
} | {
    kind: 'scope';
    patterns: string[];
    headSha: string;
    excludes?: string[];
};
interface ReviewRef {
    workspaceId: string;
    revisionId: string;
}
interface ReviewRepository {
    root: string;
    name: string;
    remoteUrl?: string;
}
/**
 * Reviewer-chosen analysis policy for the workspace. Deliberately NOT part of `ReviewSource`
 * (or any input `sourceFingerprint` hashes): it governs how deeply the analysis must explain
 * the captured diff, not what was captured, so flipping it must never change revision identity.
 * Optional so existing on-disk workspaces (predating this field) keep validating and read as
 * every policy being off.
 */
interface AnalysisPolicy {
    /** When true, every derived removal run must carry a rationale before analysis can finalize
     * (today's behavior). When false or absent, removal coverage is not enforced - rationales may
     * still be submitted and are validated for correctness, just not required. */
    explainRemovals: boolean;
}
interface ReviewWorkspace {
    schemaVersion: 1;
    id: string;
    repository: ReviewRepository;
    source: ReviewSource;
    currentRevisionId: string;
    createdAt: string;
    updatedAt: string;
    analysisPolicy?: AnalysisPolicy;
}
type ReviewItemKind = 'hunk' | 'code-section' | 'file';
type ReviewItemStatus = 'needs-review' | 'reviewed' | 'carried-forward' | 'stale';
interface ReviewRange {
    start: number;
    end: number;
}
interface ReviewItem {
    id: string;
    kind: ReviewItemKind;
    path: string;
    label: string;
    range: ReviewRange;
    contentHash: string;
    locationHash: string;
}
interface ReviewItemProgress {
    status: ReviewItemStatus;
    note?: string;
    reviewedAt?: string;
    inheritedFrom?: {
        revisionId: string;
        reviewItemId: string;
    };
}
interface ReviewProgress {
    schemaVersion: 1;
    updatedAt: string;
    items: Record<string, ReviewItemProgress>;
    activeGroupId?: string;
    activeFile?: string;
    activeReviewItemId?: string;
}
interface ReviewProgressUpdate {
    items?: Record<string, ReviewItemProgress>;
    activeGroupId?: string;
    activeFile?: string;
    activeReviewItemId?: string;
}
interface ReviewItemProgressPatch {
    status?: 'reviewed' | 'needs-review';
    note?: string | null;
}
interface WalkthroughPosition {
    activeGroupId: string;
    activeReviewItemId: string;
    activeFile?: string;
}
type DiffLineKind = 'context' | 'add' | 'remove';
type DiffFileStatus = 'added' | 'deleted' | 'modified' | 'renamed' | 'copied' | 'binary';
interface DiffLine {
    kind: DiffLineKind;
    text: string;
    oldLine: number | null;
    newLine: number | null;
    noNewlineAtEnd?: boolean;
}
interface DiffHunk {
    /** Immutable link from this captured hunk to its generated review item. */
    reviewItemId?: string;
    /** Immutable review-item hashes retained for browser-side link integrity checks. */
    reviewItemContentHash?: string;
    reviewItemLocationHash?: string;
    header: string;
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
    lines: DiffLine[];
}
interface DiffFile {
    /** Immutable link used when a file has no textual hunk to review. */
    reviewItemId?: string;
    reviewItemContentHash?: string;
    reviewItemLocationHash?: string;
    path: string;
    previousPath?: string;
    oldMode?: string;
    newMode?: string;
    /** Hash of the canonical per-file patch when Git exposes no textual rows. */
    binaryPatchHash?: string;
    status: DiffFileStatus;
    additions: number;
    deletions: number;
    binary: boolean;
    hunks: DiffHunk[];
}
interface SourceLine {
    number: number;
    text: string;
}
interface SourceFile {
    path: string;
    lines: SourceLine[];
    binary: boolean;
}
interface ReviewScopeLineRow {
    id: string;
    kind: 'scope';
    line: number;
    text: string;
}
interface ReviewDiffLineRow {
    id: string;
    kind: DiffLineKind;
    oldLine: number | null;
    newLine: number | null;
    text: string;
    noNewlineAtEnd?: boolean;
}
type ReviewLineRow = ReviewScopeLineRow | ReviewDiffLineRow;
interface ReviewItemContext {
    item: ReviewItem;
    rows: ReviewLineRow[];
}
type ReviewLineSelection = {
    kind: 'diff';
    selectedLineIds: string[];
} | {
    kind: 'scope';
    selectedLineIds: string[];
};
interface ReviewSnapshotBase {
    schemaVersion: 1;
    revisionId: string;
    /** Immutable direct predecessor captured when this workspace revision was created. */
    predecessorRevisionId?: string;
    source: ReviewSource;
    fingerprint: string;
    createdAt: string;
    items: ReviewItem[];
}
interface DiffReviewSnapshot extends ReviewSnapshotBase {
    kind: 'diff';
    files: DiffFile[];
}
interface ScopeReviewSnapshot extends ReviewSnapshotBase {
    kind: 'scope';
    files: SourceFile[];
}
type ReviewSnapshot = DiffReviewSnapshot | ScopeReviewSnapshot;
type ReviewInsightConfidence = 'high' | 'medium' | 'low';
interface ReviewItemInsight {
    reviewItemId: string;
    description: string;
    confidence: ReviewInsightConfidence;
    evidencePaths: string[];
}
interface ReviewGroup {
    id: string;
    label: string;
    intro?: string;
    reviewItemIds: string[];
}
interface ReviewFileInsight {
    path: string;
    description: string;
    confidence: ReviewInsightConfidence;
}
type RemovalReason = 'moved' | 'merged' | 'replaced' | 'dead-code' | 'obsolete' | 'extracted-to-dep' | 'unclear';
/** Reasons that assert the logic still exists somewhere and therefore require a target. */
declare const RELOCATING_REMOVAL_REASONS: readonly RemovalReason[];
interface RemovalRunRef {
    path: string;
    start: number;
    end: number;
}
/** Exact destination text captured once at analysis time so browser hosts never need git. */
interface RemovalTargetExcerpt {
    path: string;
    start: number;
    lines: string[];
}
interface RemovalRationale {
    reviewItemId: string;
    /** Old-side line span of the removed run. */
    run: RemovalRunRef;
    reason: RemovalReason;
    description: string;
    /** New-side line span where the logic landed. Present only for relocating reasons. */
    movedTo?: RemovalRunRef;
    /** Present only when `movedTo` resolves outside the captured review. */
    movedToExcerpt?: RemovalTargetExcerpt;
}
interface ReviewInsights {
    schemaVersion: 1;
    revisionId: string;
    summary?: string;
    groups: ReviewGroup[];
    items: ReviewItemInsight[];
    files?: ReviewFileInsight[];
    removals?: RemovalRationale[];
}
type ReviewQuestionStatus = 'queued' | 'processing' | 'answered' | 'failed' | 'stale';
interface ReviewClaim {
    listenerId: string;
    token: string;
    claimedAt: string;
    expiresAt: string;
}
interface ReviewQuestionEnvelope {
    schemaVersion: 1;
    id: string;
    workspaceId: string;
    revisionId: string;
    path: string;
    reviewItemId: string;
    selection: ReviewLineSelection;
    itemContext: ReviewItemContext;
    description: string;
    body: string;
    createdAt: string;
}
interface ReviewQuestion {
    schemaVersion: 1;
    id: string;
    workspaceId: string;
    revisionId: string;
    path: string;
    reviewItemId: string;
    selection: ReviewLineSelection;
    itemContext: ReviewItemContext;
    description: string;
    body: string;
    createdAt: string;
    /** Durable question-generation number used to order replay and HTTP responses. */
    generation: number;
    status: ReviewQuestionStatus;
    claim?: ReviewClaim;
    failureMessage?: string;
}
type ReviewQuestionGenerationState = 'queued' | 'claimed' | 'answer-pending' | 'answered' | 'failed' | 'stale';
interface ReviewAnswerReference {
    id: string;
    listenerId: string;
    bodyHash: string;
    createdAt: string;
}
interface ReviewQuestionGeneration {
    schemaVersion: 1;
    questionId: string;
    workspaceId: string;
    revisionId: string;
    generation: number;
    predecessorGeneration: number | null;
    predecessorHash: string | null;
    envelopeHash: string;
    state: ReviewQuestionGenerationState;
    publishedAt: string;
    claim?: ReviewClaim;
    answer?: ReviewAnswerReference;
    failureMessage?: string;
}
interface ReviewAnswer {
    schemaVersion: 1;
    id: string;
    questionId: string;
    workspaceId: string;
    revisionId: string;
    listenerId: string;
    body: string;
    createdAt: string;
}
interface ReviewQuestionInput extends Omit<ReviewQuestion, 'schemaVersion' | 'workspaceId' | 'revisionId' | 'generation' | 'status' | 'claim' | 'failureMessage'> {
}
interface ClaimResult {
    ok: boolean;
    question?: ReviewQuestion;
}
interface QuestionQueue {
    enqueue(question: ReviewQuestionInput): ReviewQuestion;
    list(): ReviewQuestion[];
    claim(questionId: string, listenerId: string, now: number, leaseMs: number): ClaimResult;
    renew(questionId: string, listenerId: string, claimToken: string, now: number, leaseMs: number): ClaimResult;
    release(questionId: string, listenerId: string, claimToken: string, now: number): boolean;
    fail(questionId: string, listenerId: string, claimToken: string, failureMessage: string, now: number): boolean;
    answer(questionId: string, listenerId: string, claimToken: string, body: string, now: number): ReviewAnswer;
    readQuestion(questionId: string): ReviewQuestion | undefined;
    readAnswer(answerId: string): ReviewAnswer | undefined;
    touchListener(listenerId: string, now?: number): void;
    removeListener(listenerId: string): void;
}
interface ReviewBundle {
    workspace: ReviewWorkspace;
    snapshot: ReviewSnapshot;
    insights: ReviewInsights;
    progress: ReviewProgress;
    questions: ReviewQuestion[];
    answers: ReviewAnswer[];
    sourceChanged: boolean;
}
interface ReviewReadiness {
    ready: boolean;
    preparing: boolean;
    pending: number;
    stale: number;
    unanswered: number;
    sourceChanged: boolean;
}
interface ActiveReviewPointer {
    schemaVersion: 1;
    workspaceId: string;
    revisionId: string;
    updatedAt: string;
}

/** Calculates readiness solely from the current snapshot, review progress, questions, and freshness. */
declare function deriveReviewReadiness(bundle: ReviewBundle, analysisFinalized?: boolean): ReviewReadiness;

interface RemovalRun {
    start: number;
    end: number;
    lineIds: string[];
    texts: string[];
}
interface SnapshotRemovalRun extends RemovalRun {
    reviewItemId: string;
    path: string;
}
type ResolvedRemovalTarget = {
    kind: 'in-review';
    reviewItemId: string;
    rowIds: string[];
    path: string;
    start: number;
    end: number;
} | {
    kind: 'excerpt';
    path: string;
    start: number;
    lines: string[];
} | {
    kind: 'unresolved';
};
interface RemovalStrip {
    run: RemovalRun;
    rationale?: RemovalRationale;
    target: ResolvedRemovalTarget;
}
/**
 * Groups maximal contiguous `remove` rows by old-side line number, preserving row order.
 * A non-removed row (or a break in old-line contiguity) closes the current run.
 */
declare function deriveRemovalRuns(rows: readonly ReviewDiffLineRow[]): RemovalRun[];
/** Every removal run across a captured diff snapshot's hunk items. Scope snapshots have none. */
declare function deriveSnapshotRemovalRuns(snapshot: ReviewSnapshot): SnapshotRemovalRun[];
/**
 * Resolves an authored `movedTo` reference: onto a captured review item (an in-review jump)
 * when the new-side target lands inside another hunk's rows, else onto the rationale's persisted
 * excerpt, else unresolved. Reads only the immutable snapshot and rationale - never the
 * filesystem or git.
 */
declare function resolveRemovalTarget(snapshot: ReviewSnapshot, rationale: RemovalRationale): ResolvedRemovalTarget;
/** One strip per derived run, in row order, with its rationale (if any) and resolved target. */
declare function buildRemovalStrips(rows: readonly ReviewDiffLineRow[], reviewItemId: string, snapshot: ReviewSnapshot, insights: Pick<ReviewInsights, 'removals'>): RemovalStrip[];

export { type SnapshotRemovalRun as $, type ActiveReviewPointer as A, type ReviewItemProgress as B, type ClaimResult as C, type DiffFile as D, type ReviewItemProgressPatch as E, type ReviewItemStatus as F, type ReviewLineRow as G, type ReviewLineSelection as H, type ReviewProgress as I, type ReviewProgressUpdate as J, type ReviewQuestion as K, type ReviewQuestionEnvelope as L, type ReviewQuestionGeneration as M, type ReviewQuestionGenerationState as N, type ReviewQuestionInput as O, type ReviewQuestionStatus as P, type QuestionQueue as Q, RELOCATING_REMOVAL_REASONS as R, type ReviewRange as S, type ReviewReadiness as T, type ReviewRef as U, type ReviewRepository as V, type ReviewScopeLineRow as W, type ReviewSnapshot as X, type ReviewSource as Y, type ReviewWorkspace as Z, type ScopeReviewSnapshot as _, type AnalysisPolicy as a, type SourceFile as a0, type SourceLine as a1, type WalkthroughPosition as a2, buildRemovalStrips as a3, deriveRemovalRuns as a4, deriveReviewReadiness as a5, deriveSnapshotRemovalRuns as a6, resolveRemovalTarget as a7, type DiffFileStatus as b, type DiffHunk as c, type DiffLine as d, type DiffLineKind as e, type DiffReviewSnapshot as f, type RemovalRationale as g, type RemovalReason as h, type RemovalRun as i, type RemovalRunRef as j, type RemovalStrip as k, type RemovalTargetExcerpt as l, type ResolvedRemovalTarget as m, type ReviewAnswer as n, type ReviewAnswerReference as o, type ReviewBundle as p, type ReviewClaim as q, type ReviewDiffLineRow as r, type ReviewFileInsight as s, type ReviewGroup as t, type ReviewInsightConfidence as u, type ReviewInsights as v, type ReviewItem as w, type ReviewItemContext as x, type ReviewItemInsight as y, type ReviewItemKind as z };
