import {
  type ReviewAnswer,
  type ReviewBundle,
  type ReviewQuestion,
  type ReviewRef,
  type ReviewSourceFreshness,
  compareReviewSourceFreshnessAsync,
  createReviewStore,
  deriveReviewReadiness,
} from '@synergy/review-core';
import type { ReviewStreamEnvironment, ReviewStreamFrame } from './review-stream.js';

export const REVIEW_FRESHNESS_TIMEOUT_MS = 30_000;

export interface AuthoritativeReviewState {
  bundle: ReviewBundle;
  freshness: ReviewSourceFreshness;
  readiness: ReturnType<typeof deriveReviewReadiness>;
  analysisFinalized: boolean;
}

interface ReviewStatePublisherOptions {
  projectRoot: string;
  reference: ReviewRef;
  environment: ReviewStreamEnvironment;
  sendState(key: string, frame: ReviewStreamFrame): void;
  sendRecord(
    kind: 'question' | 'answer',
    record: ReviewQuestion | ReviewAnswer,
    frame: ReviewStreamFrame,
  ): void;
}

/** Reads a bundle and off-thread freshness exactly once so source/readiness cannot disagree. */
async function readAuthoritativeState(
  projectRoot: string,
  reference: ReviewRef,
  environment: ReviewStreamEnvironment,
  signal: AbortSignal,
): Promise<AuthoritativeReviewState> {
  const store = createReviewStore(projectRoot);
  // The finalized marker follows the atomic bundle replacement. Read it first so a transition
  // can only produce a conservative pending marker with a finalized bundle, never the inverse.
  const analysisFinalized = store.isAnalysisFinalized(reference.workspaceId, reference.revisionId);
  const bundle = store.readBundle(reference.workspaceId, reference.revisionId);
  let freshness: ReviewSourceFreshness;
  try {
    freshness = await (
      environment.compareSourceFreshnessAsync ?? compareReviewSourceFreshnessAsync
    ).call(environment, bundle.snapshot, projectRoot, {
      timeoutMs: environment.freshnessTimeoutMs ?? REVIEW_FRESHNESS_TIMEOUT_MS,
      signal,
    });
  } catch {
    freshness = { sourceChanged: true, captureFailed: true };
  }
  const freshBundle = { ...bundle, sourceChanged: freshness.sourceChanged };
  return {
    bundle: freshBundle,
    freshness,
    readiness: deriveReviewReadiness(freshBundle, analysisFinalized),
    analysisFinalized,
  };
}

/** De-duplicates state while replaying every current durable record on first connection. */
export class ReviewStatePublisher {
  private lastSourceSignature: string | undefined;
  private lastProgressSignature: string | undefined;
  private lastCaptureFailed = false;
  private questionSignatures = new Map<string, string>();
  private answerSignatures = new Map<string, string>();

  constructor(private readonly options: ReviewStatePublisherOptions) {}

  read(signal: AbortSignal): Promise<AuthoritativeReviewState> {
    return readAuthoritativeState(
      this.options.projectRoot,
      this.options.reference,
      this.options.environment,
      signal,
    );
  }

  publish(state: AuthoritativeReviewState, force: boolean): void {
    const sourceSignature = JSON.stringify(state.freshness);
    if (force || sourceSignature !== this.lastSourceSignature) {
      this.lastSourceSignature = sourceSignature;
      this.options.sendState('source', {
        type: 'source',
        changed: state.freshness.sourceChanged,
        captureFailed: state.freshness.captureFailed,
      });
    }
    const progressSignature = JSON.stringify([
      state.bundle.progress,
      state.readiness,
      state.analysisFinalized,
    ]);
    if (force || progressSignature !== this.lastProgressSignature) {
      this.lastProgressSignature = progressSignature;
      this.options.sendState('progress', {
        type: 'progress',
        progress: state.bundle.progress,
        readiness: state.readiness,
        analysisFinalized: state.analysisFinalized,
      });
    }
    this.publishRecords(state, force);

    if (state.freshness.captureFailed && (!this.lastCaptureFailed || force)) {
      this.options.sendState('interruption', {
        type: 'interruption',
        code: 'source_capture_failed',
        recoverable: true,
      });
    }
    this.lastCaptureFailed = state.freshness.captureFailed;
  }

  private publishRecords(state: AuthoritativeReviewState, force: boolean): void {
    const nextQuestions = new Map<string, string>();
    for (const question of state.bundle.questions) {
      const signature = JSON.stringify(question);
      nextQuestions.set(question.id, signature);
      if (force || this.questionSignatures.get(question.id) !== signature) {
        this.options.sendRecord('question', question, { type: 'question', question });
      }
    }
    const nextAnswers = new Map<string, string>();
    for (const answer of state.bundle.answers) {
      const signature = JSON.stringify(answer);
      nextAnswers.set(answer.id, signature);
      if (force || this.answerSignatures.get(answer.id) !== signature) {
        this.options.sendRecord('answer', answer, { type: 'answer', answer });
      }
    }
    this.questionSignatures = nextQuestions;
    this.answerSignatures = nextAnswers;
  }
}
