export type ReviewSource =
  | { kind: 'pr'; number: number; url: string; baseSha: string; headSha: string }
  | { kind: 'staged'; headSha: string }
  | { kind: 'unstaged'; headSha: string }
  | { kind: 'scope'; patterns: string[]; headSha: string };

export interface ReviewRef {
  workspaceId: string;
  revisionId: string;
}

export interface ReviewRepository {
  root: string;
  name: string;
  remoteUrl?: string;
}

export interface ReviewWorkspace {
  schemaVersion: 1;
  id: string;
  repository: ReviewRepository;
  source: ReviewSource;
  currentRevisionId: string;
  createdAt: string;
  updatedAt: string;
}

export type ReviewItemKind = 'hunk' | 'code-section' | 'file';
export type ReviewItemStatus = 'needs-review' | 'reviewed' | 'carried-forward' | 'stale';

export interface ReviewRange {
  start: number;
  end: number;
}

export interface ReviewItem {
  id: string;
  kind: ReviewItemKind;
  path: string;
  label: string;
  range: ReviewRange;
  contentHash: string;
  locationHash: string;
}

export interface ReviewItemProgress {
  status: ReviewItemStatus;
  note?: string;
  reviewedAt?: string;
  inheritedFrom?: { revisionId: string; reviewItemId: string };
}

export interface ReviewProgress {
  schemaVersion: 1;
  updatedAt: string;
  items: Record<string, ReviewItemProgress>;
  activeGroupId?: string;
  activeFile?: string;
  activeReviewItemId?: string;
}

export interface ReviewProgressUpdate {
  items?: Record<string, ReviewItemProgress>;
  activeGroupId?: string;
  activeFile?: string;
  activeReviewItemId?: string;
}

export interface ReviewItemProgressPatch {
  status?: 'reviewed' | 'needs-review';
  note?: string | null;
}

export interface WalkthroughPosition {
  activeGroupId: string;
  activeReviewItemId: string;
  activeFile?: string;
}

export type DiffLineKind = 'context' | 'add' | 'remove';
export type DiffFileStatus = 'added' | 'deleted' | 'modified' | 'renamed' | 'copied' | 'binary';

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  oldLine: number | null;
  newLine: number | null;
  noNewlineAtEnd?: boolean;
}

export interface DiffHunk {
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

export interface DiffFile {
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

export interface SourceLine {
  number: number;
  text: string;
}

export interface SourceFile {
  path: string;
  lines: SourceLine[];
  binary: boolean;
}

export interface ReviewScopeLineRow {
  id: string;
  kind: 'scope';
  line: number;
  text: string;
}

export interface ReviewDiffLineRow {
  id: string;
  kind: DiffLineKind;
  oldLine: number | null;
  newLine: number | null;
  text: string;
  noNewlineAtEnd?: boolean;
}

export type ReviewLineRow = ReviewScopeLineRow | ReviewDiffLineRow;

export interface ReviewItemContext {
  item: ReviewItem;
  rows: ReviewLineRow[];
}

export type ReviewLineSelection =
  | { kind: 'diff'; selectedLineIds: string[] }
  | { kind: 'scope'; selectedLineIds: string[] };

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

export interface DiffReviewSnapshot extends ReviewSnapshotBase {
  kind: 'diff';
  files: DiffFile[];
}

export interface ScopeReviewSnapshot extends ReviewSnapshotBase {
  kind: 'scope';
  files: SourceFile[];
}

export type ReviewSnapshot = DiffReviewSnapshot | ScopeReviewSnapshot;

export type ReviewInsightConfidence = 'high' | 'medium' | 'low';

export interface ReviewItemInsight {
  reviewItemId: string;
  description: string;
  confidence: ReviewInsightConfidence;
  evidencePaths: string[];
}

export interface ReviewGroup {
  id: string;
  label: string;
  intro?: string;
  reviewItemIds: string[];
}

export interface ReviewFileInsight {
  path: string;
  description: string;
  confidence: ReviewInsightConfidence;
}

export type RemovalReason =
  | 'moved'
  | 'merged'
  | 'replaced'
  | 'dead-code'
  | 'obsolete'
  | 'extracted-to-dep'
  | 'unclear';

/** Reasons that assert the logic still exists somewhere and therefore require a target. */
export const RELOCATING_REMOVAL_REASONS: readonly RemovalReason[] = ['moved', 'merged', 'replaced'];

export interface RemovalRunRef {
  path: string;
  start: number;
  end: number;
}

/** Exact destination text captured once at analysis time so browser hosts never need git. */
export interface RemovalTargetExcerpt {
  path: string;
  start: number;
  lines: string[];
}

export interface RemovalRationale {
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

export interface ReviewInsights {
  schemaVersion: 1;
  revisionId: string;
  summary?: string;
  groups: ReviewGroup[];
  items: ReviewItemInsight[];
  files?: ReviewFileInsight[];
  removals?: RemovalRationale[];
}

export type ReviewQuestionStatus = 'queued' | 'processing' | 'answered' | 'failed' | 'stale';

export interface ReviewClaim {
  listenerId: string;
  token: string;
  claimedAt: string;
  expiresAt: string;
}

export interface ReviewQuestionEnvelope {
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

export interface ReviewQuestion {
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

export type ReviewQuestionGenerationState =
  | 'queued'
  | 'claimed'
  | 'answer-pending'
  | 'answered'
  | 'failed'
  | 'stale';

export interface ReviewAnswerReference {
  id: string;
  listenerId: string;
  bodyHash: string;
  createdAt: string;
}

export interface ReviewQuestionGeneration {
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

export interface ReviewAnswer {
  schemaVersion: 1;
  id: string;
  questionId: string;
  workspaceId: string;
  revisionId: string;
  listenerId: string;
  body: string;
  createdAt: string;
}

export interface ReviewQuestionInput
  extends Omit<
    ReviewQuestion,
    | 'schemaVersion'
    | 'workspaceId'
    | 'revisionId'
    | 'generation'
    | 'status'
    | 'claim'
    | 'failureMessage'
  > {}

export interface ClaimResult {
  ok: boolean;
  question?: ReviewQuestion;
}

export interface QuestionQueue {
  enqueue(question: ReviewQuestionInput): ReviewQuestion;
  list(): ReviewQuestion[];
  claim(questionId: string, listenerId: string, now: number, leaseMs: number): ClaimResult;
  renew(
    questionId: string,
    listenerId: string,
    claimToken: string,
    now: number,
    leaseMs: number,
  ): ClaimResult;
  release(questionId: string, listenerId: string, claimToken: string, now: number): boolean;
  fail(
    questionId: string,
    listenerId: string,
    claimToken: string,
    failureMessage: string,
    now: number,
  ): boolean;
  answer(
    questionId: string,
    listenerId: string,
    claimToken: string,
    body: string,
    now: number,
  ): ReviewAnswer;
  readQuestion(questionId: string): ReviewQuestion | undefined;
  readAnswer(answerId: string): ReviewAnswer | undefined;
  touchListener(listenerId: string, now?: number): void;
  removeListener(listenerId: string): void;
}

export interface ReviewBundle {
  workspace: ReviewWorkspace;
  snapshot: ReviewSnapshot;
  insights: ReviewInsights;
  progress: ReviewProgress;
  questions: ReviewQuestion[];
  answers: ReviewAnswer[];
  sourceChanged: boolean;
}

export interface ReviewReadiness {
  ready: boolean;
  preparing: boolean;
  pending: number;
  stale: number;
  unanswered: number;
  sourceChanged: boolean;
}

export interface ActiveReviewPointer {
  schemaVersion: 1;
  workspaceId: string;
  revisionId: string;
  updatedAt: string;
}
