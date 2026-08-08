type ReviewSource = {
    kind: 'pr';
    number: number;
    url: string;
    baseSha: string;
    headSha: string;
} | {
    kind: 'staged';
    headSha: string;
} | {
    kind: 'unstaged';
    headSha: string;
} | {
    kind: 'scope';
    patterns: string[];
    headSha: string;
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
interface ReviewWorkspace {
    schemaVersion: 1;
    id: string;
    repository: ReviewRepository;
    source: ReviewSource;
    currentRevisionId: string;
    createdAt: string;
    updatedAt: string;
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
    reviewItemIds: string[];
}
interface ReviewFileInsight {
    path: string;
    description: string;
    confidence: ReviewInsightConfidence;
}
interface ReviewInsights {
    schemaVersion: 1;
    revisionId: string;
    groups: ReviewGroup[];
    items: ReviewItemInsight[];
    files?: ReviewFileInsight[];
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

export { type ActiveReviewPointer as A, type ReviewQuestionGeneration as B, type ClaimResult as C, type DiffFile as D, type ReviewQuestionGenerationState as E, type ReviewQuestionInput as F, type ReviewQuestionStatus as G, type ReviewRange as H, type ReviewReadiness as I, type ReviewRef as J, type ReviewRepository as K, type ReviewScopeLineRow as L, type ReviewSnapshot as M, type ReviewSource as N, type ReviewWorkspace as O, type SourceFile as P, type QuestionQueue as Q, type ReviewAnswer as R, type ScopeReviewSnapshot as S, type SourceLine as T, deriveReviewReadiness as U, type DiffFileStatus as a, type DiffHunk as b, type DiffLine as c, type DiffLineKind as d, type DiffReviewSnapshot as e, type ReviewAnswerReference as f, type ReviewBundle as g, type ReviewClaim as h, type ReviewDiffLineRow as i, type ReviewFileInsight as j, type ReviewGroup as k, type ReviewInsightConfidence as l, type ReviewInsights as m, type ReviewItem as n, type ReviewItemContext as o, type ReviewItemInsight as p, type ReviewItemKind as q, type ReviewItemProgress as r, type ReviewItemProgressPatch as s, type ReviewItemStatus as t, type ReviewLineRow as u, type ReviewLineSelection as v, type ReviewProgress as w, type ReviewProgressUpdate as x, type ReviewQuestion as y, type ReviewQuestionEnvelope as z };
