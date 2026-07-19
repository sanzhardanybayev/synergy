import type { ReviewBundle, ReviewReadiness } from '@synergy/review-core';
import {
  deriveReviewReadiness,
  resolveBrowserReviewItemContext,
} from '@synergy/review-core/browser';
import type { ReviewBundleResponse, ReviewStreamFrame } from '../api.js';
import type { ReviewLoadStatus, ReviewStreamStatus } from './types.js';

export interface ReviewState {
  status: ReviewLoadStatus;
  error: string | null;
  bundle: ReviewBundle | null;
  readiness: ReviewReadiness | null;
  analysisFinalized: boolean;
  activeItemId: string | null;
  selections: Record<string, string[]>;
  noteDrafts: Record<string, string>;
  questionDrafts: Record<string, string>;
  savingItemIds: Set<string>;
  isSendingQuestion: boolean;
  isListening: boolean;
  streamStatus: ReviewStreamStatus;
  interruptionCode: string | null;
  captureFailed: boolean;
  presenceOrder: number;
  sourceOrder: number;
}

export type ReviewAction =
  | { type: 'loading' }
  | { type: 'loaded'; payload: ReviewBundleResponse }
  | { type: 'load-failed'; error: string }
  | { type: 'set-error'; error: string | null }
  | { type: 'set-active'; reviewItemId: string | null }
  | { type: 'toggle-line'; reviewItemId: string; lineId: string }
  | { type: 'clear-lines'; reviewItemId: string }
  | { type: 'set-note'; reviewItemId: string; value: string }
  | { type: 'clear-note'; reviewItemId: string; expectedValue: string }
  | { type: 'set-question'; reviewItemId: string; value: string }
  | {
      type: 'clear-question';
      reviewItemId: string;
      expectedBody: string;
      expectedLineIds: string[];
    }
  | { type: 'set-saving'; reviewItemId: string; saving: boolean }
  | { type: 'set-sending'; sending: boolean }
  | { type: 'stream-status'; status: ReviewStreamStatus }
  | { type: 'stream-open' }
  | { type: 'stream-frame'; frame: ReviewStreamFrame; order: number };

export const EMPTY_REVIEW_STATE: ReviewState = {
  status: 'loading',
  error: null,
  bundle: null,
  readiness: null,
  analysisFinalized: false,
  activeItemId: null,
  selections: {},
  noteDrafts: {},
  questionDrafts: {},
  savingItemIds: new Set(),
  isSendingQuestion: false,
  isListening: false,
  streamStatus: 'connecting',
  interruptionCode: null,
  captureFailed: false,
  presenceOrder: 0,
  sourceOrder: 0,
};

function deriveReadiness(bundle: ReviewBundle, analysisFinalized: boolean): ReviewReadiness {
  return deriveReviewReadiness(bundle, analysisFinalized);
}

function upsertById<T extends { id: string }>(items: T[], next: T): T[] {
  return items.some((item) => item.id === next.id)
    ? items.map((item) => (item.id === next.id ? next : item))
    : [...items, next];
}

function mergeQuestions(
  current: NonNullable<ReviewState['bundle']>['questions'],
  incoming: NonNullable<ReviewState['bundle']>['questions'],
): NonNullable<ReviewState['bundle']>['questions'] {
  const byId = new Map(current.map((question) => [question.id, question]));
  for (const question of incoming) {
    const existing = byId.get(question.id);
    if (!existing || question.generation > existing.generation) byId.set(question.id, question);
  }
  return [...byId.values()];
}

function mergeAnswers(
  current: NonNullable<ReviewState['bundle']>['answers'],
  incoming: NonNullable<ReviewState['bundle']>['answers'],
): NonNullable<ReviewState['bundle']>['answers'] {
  const byId = new Map(current.map((answer) => [answer.id, answer]));
  for (const answer of incoming) if (!byId.has(answer.id)) byId.set(answer.id, answer);
  return [...byId.values()];
}

function withResponse(state: ReviewState, payload: ReviewBundleResponse): ReviewState {
  const activeItemId = payload.bundle.snapshot.items.some((item) => item.id === state.activeItemId)
    ? state.activeItemId
    : (payload.bundle.snapshot.items[0]?.id ?? null);
  const acceptsProgress =
    !state.bundle || payload.bundle.progress.updatedAt > state.bundle.progress.updatedAt;
  const bundle = state.bundle
    ? {
        ...payload.bundle,
        progress: acceptsProgress ? payload.bundle.progress : state.bundle.progress,
        questions: mergeQuestions(state.bundle.questions, payload.bundle.questions),
        answers: mergeAnswers(state.bundle.answers, payload.bundle.answers),
      }
    : payload.bundle;
  const sourceAuthoritativeBundle =
    state.sourceOrder > 0 && state.bundle
      ? { ...bundle, sourceChanged: state.bundle.sourceChanged }
      : bundle;
  const readiness = deriveReadiness(sourceAuthoritativeBundle, payload.analysisFinalized);
  const selections = Object.fromEntries(
    Object.entries(state.selections).flatMap(([reviewItemId, selectedLineIds]) => {
      try {
        const validRows = new Set(
          resolveBrowserReviewItemContext(
            sourceAuthoritativeBundle.snapshot,
            reviewItemId,
          ).rows.map((row) => row.id),
        );
        const validSelection = selectedLineIds.filter((lineId) => validRows.has(lineId));
        return validSelection.length ? [[reviewItemId, validSelection]] : [];
      } catch {
        return [];
      }
    }),
  );
  const itemIds = new Set(sourceAuthoritativeBundle.snapshot.items.map((item) => item.id));
  const noteDrafts = Object.fromEntries(
    Object.entries(state.noteDrafts).filter(([reviewItemId]) => itemIds.has(reviewItemId)),
  );
  const questionDrafts = Object.fromEntries(
    Object.entries(state.questionDrafts).filter(([reviewItemId]) => itemIds.has(reviewItemId)),
  );
  return {
    ...state,
    status: 'ready',
    error: null,
    bundle: sourceAuthoritativeBundle,
    readiness,
    analysisFinalized: payload.analysisFinalized,
    activeItemId,
    selections,
    noteDrafts,
    questionDrafts,
    captureFailed: state.captureFailed,
  };
}

export function reviewReducer(state: ReviewState, action: ReviewAction): ReviewState {
  switch (action.type) {
    case 'loading':
      return { ...EMPTY_REVIEW_STATE };
    case 'loaded':
      return withResponse(state, action.payload);
    case 'load-failed':
      return { ...state, status: 'error', error: action.error, streamStatus: 'interrupted' };
    case 'set-error':
      return { ...state, error: action.error };
    case 'set-active':
      return { ...state, activeItemId: action.reviewItemId, selections: {} };
    case 'toggle-line': {
      const selected = state.selections[action.reviewItemId] ?? [];
      return {
        ...state,
        selections: {
          ...state.selections,
          [action.reviewItemId]: selected.includes(action.lineId)
            ? selected.filter((lineId) => lineId !== action.lineId)
            : [...selected, action.lineId],
        },
      };
    }
    case 'clear-lines':
      return { ...state, selections: { ...state.selections, [action.reviewItemId]: [] } };
    case 'set-note':
      return { ...state, noteDrafts: { ...state.noteDrafts, [action.reviewItemId]: action.value } };
    case 'clear-note': {
      if (state.noteDrafts[action.reviewItemId] !== action.expectedValue) return state;
      const { [action.reviewItemId]: _cleared, ...noteDrafts } = state.noteDrafts;
      return { ...state, noteDrafts };
    }
    case 'set-question':
      return {
        ...state,
        questionDrafts: { ...state.questionDrafts, [action.reviewItemId]: action.value },
      };
    case 'clear-question': {
      const selected = state.selections[action.reviewItemId] ?? [];
      const selectionMatches =
        selected.length === action.expectedLineIds.length &&
        selected.every((lineId, index) => lineId === action.expectedLineIds[index]);
      if (state.questionDrafts[action.reviewItemId] !== action.expectedBody || !selectionMatches) {
        return state;
      }
      const { [action.reviewItemId]: _cleared, ...questionDrafts } = state.questionDrafts;
      return {
        ...state,
        questionDrafts,
        selections: { ...state.selections, [action.reviewItemId]: [] },
      };
    }
    case 'set-saving': {
      const savingItemIds = new Set(state.savingItemIds);
      action.saving
        ? savingItemIds.add(action.reviewItemId)
        : savingItemIds.delete(action.reviewItemId);
      return { ...state, savingItemIds };
    }
    case 'set-sending':
      return { ...state, isSendingQuestion: action.sending };
    case 'stream-status':
      return {
        ...state,
        streamStatus: action.status,
        isListening: action.status === 'interrupted' ? false : state.isListening,
      };
    case 'stream-open':
      return {
        ...state,
        streamStatus: 'connected',
        interruptionCode:
          state.interruptionCode === 'stream_unavailable' ||
          state.interruptionCode === 'review_unavailable'
            ? null
            : state.interruptionCode,
      };
    case 'stream-frame': {
      if (!state.bundle || !state.readiness) return state;
      const { frame } = action;
      if (frame.type === 'presence') {
        if (action.order <= state.presenceOrder) return state;
        return {
          ...state,
          isListening: frame.listening,
          presenceOrder: action.order,
        };
      }
      if (frame.type === 'question') {
        const existing = state.bundle.questions.find(
          (question) => question.id === frame.question.id,
        );
        if (existing && existing.generation >= frame.question.generation) return state;
        const bundle = {
          ...state.bundle,
          questions: upsertById(state.bundle.questions, frame.question),
        };
        return {
          ...state,
          bundle,
          readiness: deriveReadiness(bundle, state.analysisFinalized),
        };
      }
      if (frame.type === 'answer') {
        if (state.bundle.answers.some((answer) => answer.id === frame.answer.id)) return state;
        return {
          ...state,
          bundle: { ...state.bundle, answers: [...state.bundle.answers, frame.answer] },
        };
      }
      if (frame.type === 'progress') {
        if (frame.progress.updatedAt <= state.bundle.progress.updatedAt) return state;
        const bundle = { ...state.bundle, progress: frame.progress };
        return {
          ...state,
          bundle,
          readiness: deriveReadiness(bundle, state.analysisFinalized),
        };
      }
      if (frame.type === 'source') {
        if (action.order <= state.sourceOrder) return state;
        const hasRecoveredSourceCapture =
          state.interruptionCode === 'source_capture_failed' && !frame.captureFailed;
        return {
          ...state,
          bundle: { ...state.bundle, sourceChanged: frame.changed },
          readiness: deriveReadiness(
            { ...state.bundle, sourceChanged: frame.changed },
            state.analysisFinalized,
          ),
          captureFailed: frame.captureFailed,
          sourceOrder: action.order,
          interruptionCode: hasRecoveredSourceCapture ? null : state.interruptionCode,
        };
      }
      const sourceCaptureFailed = frame.code === 'source_capture_failed';
      return {
        ...state,
        streamStatus: sourceCaptureFailed ? state.streamStatus : 'interrupted',
        isListening: sourceCaptureFailed ? state.isListening : false,
        interruptionCode: frame.code,
        captureFailed: sourceCaptureFailed || state.captureFailed,
      };
    }
  }
}
