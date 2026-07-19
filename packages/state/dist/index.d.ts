import { StatusValue } from '@synergy/spec-kit';
export { StatusValue } from '@synergy/spec-kit';

declare const STATE_DIRNAME = ".state";
/** Absolute path to a session's `.state/` directory. */
declare function stateDir(sessionDir: string): string;
declare function progressPath(sessionDir: string): string;
declare function phaseJournalPath(sessionDir: string, phaseId: string): string;
declare function globalJournalPath(sessionDir: string): string;
declare function handoffPath(sessionDir: string): string;

interface PhaseState {
    /** Stable phase slug (no numeric prefix), e.g. "cutover". */
    slug: string;
    status: StatusValue;
    startedAt?: string;
    completedAt?: string;
    updatedAt?: string;
}
interface ResumePointer {
    /** Slug of the phase a fresh agent should start with. */
    nextPhase?: string;
    /** Free-text "start here" note. */
    note?: string;
}
interface ProgressFile {
    version: 1;
    /** Authored overall status; may differ from the derived rollup. */
    overallStatus: StatusValue;
    resume: ResumePointer;
    phases: PhaseState[];
    updatedAt?: string;
}
interface DerivedProgress {
    done: number;
    total: number;
    /** Integer 0..100. */
    percent: number;
}

declare function emptyProgress(): ProgressFile;
declare function readProgress(sessionDir: string): ProgressFile;
/** Atomic JSON write: mkdir -p, write .tmp, rename over target. */
declare function writeProgress(sessionDir: string, data: ProgressFile): void;
declare function deriveProgress(progress: ProgressFile): DerivedProgress;

type NowFn$1 = () => string;
/** Write the latest-wins handoff baton. Atomic: tmp + rename. Overwrites any prior file. */
declare function writeHandoff(sessionDir: string, body: string, now?: NowFn$1): void;
/** Read the current handoff baton, or null when none exists. */
declare function readHandoff(sessionDir: string): string | null;

type NowFn = () => string;
interface SetPhaseOptions {
    /** Optional boundary note appended to the phase journal. */
    note?: string;
    now?: NowFn;
}
/** Set a phase's status, stamping start/complete timestamps and (optionally) a boundary note. */
declare function setPhaseStatus(sessionDir: string, phaseId: string, status: StatusValue, opts?: SetPhaseOptions): void;
type FindingTarget = {
    phase: string;
} | {
    global: true;
};
/** Append an ad-hoc finding to a phase journal or the global journal. */
declare function appendFinding(sessionDir: string, target: FindingTarget, text: string, now?: NowFn): void;
/** Set the resume pointer a fresh agent reads first. Merges: only provided fields overwrite. */
declare function setResume(sessionDir: string, resume: ResumePointer, now?: NowFn): void;

declare function readPhaseJournal(sessionDir: string, phaseId: string): string | null;
declare function readGlobalJournal(sessionDir: string): string | null;

/**
 * Filenames for the feedback-wait control channel: files dropped into
 * `<feedbackDir>/<session>/` alongside `.md` comment files. Shared by
 * `@synergy/cli`'s `feedback-wait` (the waiter) and `@synergy/preview`'s
 * `review-done`/`feedback-stream` server routes (the writers), so both sides
 * must agree on these names.
 */
/**
 * Control file the preview server writes when the user clicks "Done
 * reviewing". Its appearance ends an active `synergy feedback wait`.
 */
declare const REVIEW_DONE_FILE = ".review-done";
/**
 * Presence marker maintained while a `synergy feedback wait` is active
 * (30s heartbeat touch, removed on exit). The preview's feedback SSE stream
 * stats this file (mtime freshness) to show "agent listening" in the browser.
 */
declare const LISTENING_FILE = ".listening";

/** JSON Schema for .state/progress.json — compiled by @synergy/validator's ajv. */
declare const progressJsonSchema: {
    readonly type: "object";
    readonly required: readonly ["version", "phases"];
    readonly additionalProperties: true;
    readonly properties: {
        readonly version: {
            readonly const: 1;
        };
        readonly overallStatus: {
            readonly enum: readonly ["draft", "proposed", "in-progress", "blocked", "done", "shipped"];
        };
        readonly resume: {
            readonly type: "object";
            readonly properties: {
                readonly nextPhase: {
                    readonly type: "string";
                };
                readonly note: {
                    readonly type: "string";
                };
            };
        };
        readonly phases: {
            readonly type: "array";
            readonly items: {
                readonly type: "object";
                readonly required: readonly ["slug", "status"];
                readonly properties: {
                    readonly slug: {
                        readonly type: "string";
                    };
                    readonly status: {
                        readonly enum: readonly ["draft", "proposed", "in-progress", "blocked", "done", "shipped"];
                    };
                    readonly startedAt: {
                        readonly type: "string";
                    };
                    readonly completedAt: {
                        readonly type: "string";
                    };
                    readonly updatedAt: {
                        readonly type: "string";
                    };
                };
            };
        };
    };
};

export { type DerivedProgress, type FindingTarget, LISTENING_FILE, type PhaseState, type ProgressFile, REVIEW_DONE_FILE, type ResumePointer, STATE_DIRNAME, type SetPhaseOptions, appendFinding, deriveProgress, emptyProgress, globalJournalPath, handoffPath, phaseJournalPath, progressJsonSchema, progressPath, readGlobalJournal, readHandoff, readPhaseJournal, readProgress, setPhaseStatus, setResume, stateDir, writeHandoff, writeProgress };
