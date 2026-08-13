import type {
  DiffFile,
  ReviewBundle,
  ReviewItemProgressPatch,
  ReviewReadiness,
  ReviewRef,
  WalkthroughPosition,
} from '@synergy/review-core';
import type { ResolvedRemovalTarget } from '@synergy/review-core/browser';
import type {
  ReviewBundleResponse,
  ReviewQuestionResponse,
  ReviewStreamConnection,
  ReviewStreamHandlers,
} from '../api.js';
import type { Chapter } from './walkthrough.js';

export interface ReviewClient {
  getBundle(reference: ReviewRef, signal?: AbortSignal): Promise<ReviewBundleResponse>;
  patchProgress(
    reference: ReviewRef,
    reviewItemId: string,
    patch: ReviewItemProgressPatch,
    signal?: AbortSignal,
  ): Promise<ReviewBundleResponse>;
  postQuestion(
    reference: ReviewRef,
    reviewItemId: string,
    selectedLineIds: string[],
    body: string,
    signal?: AbortSignal,
  ): Promise<ReviewQuestionResponse>;
  postActive(reference: ReviewRef, signal?: AbortSignal): Promise<void>;
  patchWalkthrough(
    reference: ReviewRef,
    position: WalkthroughPosition,
    signal?: AbortSignal,
  ): Promise<ReviewBundleResponse>;
  openStream(reference: ReviewRef, handlers: ReviewStreamHandlers): ReviewStreamConnection;
}

export interface FileChangeViewerProps {
  file: DiffFile;
}

export type ReviewLoadStatus = 'loading' | 'ready' | 'error';
export type ReviewStreamStatus = 'connecting' | 'connected' | 'interrupted';

/** The only removal target shape a jump can land on - the other two kinds have nothing to jump to. */
export type InReviewRemovalTarget = Extract<ResolvedRemovalTarget, { kind: 'in-review' }>;

export interface JumpOrigin {
  reviewItemId: string;
  /** `path:line` - names where the jump came from so the back chip is self-explanatory. */
  label: string;
}

export interface ReviewContextValue {
  status: ReviewLoadStatus;
  error: string | null;
  bundle: ReviewBundle | null;
  readiness: ReviewReadiness | null;
  analysisFinalized: boolean;
  activeItemId: string | null;
  selectedLineIds: string[];
  noteDrafts: Readonly<Record<string, string>>;
  questionDraft: string;
  savingItemIds: ReadonlySet<string>;
  isSendingQuestion: boolean;
  isListening: boolean;
  streamStatus: ReviewStreamStatus;
  interruptionCode: string | null;
  sourceChanged: boolean;
  captureFailed: boolean;
  walkthrough: {
    enabled: boolean;
    chapters: Chapter[];
    revealedCount: number;
    revealAll: boolean;
    advanceTo(reviewItemId: string): void;
    setRevealAll(): void;
  };
  jump: {
    /** Set by the most recent `jumpTo`; persists until the next jump or `clearOrigin`. */
    origin: JumpOrigin | null;
    /** Row ids to render with a transient flash; cleared automatically ~1.2s after a jump. */
    flashedRowIds: string[];
    /** Moves the walkthrough cursor to the target item and records where the jump came from. Never touches review status. */
    jumpTo(target: InReviewRemovalTarget, origin: JumpOrigin): void;
    clearOrigin(): void;
  };
  retry(): Promise<void>;
  setActiveItem(reviewItemId: string): void;
  toggleSelectedLine(lineId: string): void;
  clearSelectedLines(): void;
  setNoteDraft(reviewItemId: string, value: string): void;
  saveNote(reviewItemId: string): Promise<void>;
  markProgress(reviewItemId: string, status: 'reviewed' | 'needs-review'): Promise<void>;
  setQuestionDraft(value: string): void;
  sendQuestion(): Promise<void>;
}
