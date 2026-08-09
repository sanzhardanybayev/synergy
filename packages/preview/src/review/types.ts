import type {
  DiffFile,
  ReviewBundle,
  ReviewItemProgressPatch,
  ReviewReadiness,
  ReviewRef,
  WalkthroughPosition,
} from '@synergy/review-core';
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
