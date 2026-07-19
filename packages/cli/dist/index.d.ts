import { StatusValue } from '@synergy/state';
import { ReviewRef, ReviewGroup, ReviewItemInsight, ProposedCodeSection, CaptureReviewSourceRequest, createReviewStore, compareReviewSourceFreshness, deriveReviewReadiness, ReviewWorkspace, ReviewCaptureSourceRequest } from '@synergy/review-core';
export { CaptureReviewSourceRequest, CapturedReviewSource, CommandResult, CommandRunner, capturePr, captureReviewSource, captureScope, captureStaged, captureUnstaged } from '@synergy/review-core';
import { CAC } from 'cac';

declare function initProject(root?: string): {
    synergyDir: string;
};

interface PreviewStartOptions {
    root?: string;
    port?: number;
    background?: boolean;
}
interface PreviewTimings {
    lockMs: number;
    launchMs: number;
    listenMs: number;
    healthMs: number;
    totalMs: number;
}
interface PreviewStatus {
    running: boolean;
    pid: number | null;
    port: number | null;
    origin: string | null;
    projectId: string;
    instanceId: string | null;
    timings?: PreviewTimings;
}
declare function previewStatus(root?: string): Promise<PreviewStatus>;
declare function previewStart(options?: PreviewStartOptions): Promise<PreviewStatus>;
declare function previewStop(root?: string): Promise<boolean>;
declare function printStatus(status: PreviewStatus): void;

interface ProjectPaths {
    root: string;
    synergyDir: string;
    sessionsDir: string;
    feedbackDir: string;
    reviewsDir: string;
    activeReviewFile: string;
    previewRuntimeFile: string;
    previewLockFile: string;
    previewPidFile: string;
    previewLogFile: string;
}
declare function resolveProjectPaths(root?: string): ProjectPaths;
declare const PREVIEW_PORT = 4321;

interface PhaseSetArgs {
    root?: string;
    session: string;
    phaseId: string;
    status: StatusValue;
    note?: string;
}
declare function phaseSet(args: PhaseSetArgs): void;
interface LogArgs {
    root?: string;
    session: string;
    text: string;
    phase?: string;
    global?: boolean;
}
declare function logFinding(args: LogArgs): void;
interface ResumeArgs {
    root?: string;
    session: string;
    next?: string;
    note?: string;
}
declare function resumeSet(args: ResumeArgs): void;
interface ProgressArgs {
    root?: string;
    session: string;
}
/** Returns the rendered summary (also used by tests); the CLI action writes it to stdout. */
declare function printProgress(args: ProgressArgs): string;

interface CreateReviewRequest extends CaptureReviewSourceRequest {
}
interface CreateReviewResult {
    reference: ReviewRef;
    resumed: boolean;
    url: string;
    analysisRequired: boolean;
}
interface ReviewActionDependencies {
    createStore?: typeof createReviewStore;
}
interface OpenReviewDependencies {
    previewStatus?: typeof previewStatus;
}
interface RefreshReviewRequest {
    root: string;
    workspaceId: string;
    runner?: CaptureReviewSourceRequest['runner'];
    readFile?: CaptureReviewSourceRequest['readFile'];
}
interface ReviewAnalysis {
    groups: ReviewGroup[];
    items: ReviewItemInsight[];
    sections?: ProposedCodeSection[];
}
interface ApplyReviewAnalysisRequest {
    root: string;
    reference: ReviewRef;
    analysis: ReviewAnalysis;
}
interface ReviewStatusRequest {
    root: string;
    reference: ReviewRef;
    runner?: CaptureReviewSourceRequest['runner'];
    readFile?: CaptureReviewSourceRequest['readFile'];
    compareSourceFreshness?: typeof compareReviewSourceFreshness;
}
interface ReviewStatusResult {
    reference: string;
    analysisRequired: boolean;
    readiness: ReturnType<typeof deriveReviewReadiness>;
    captureFailed: boolean;
    url: string;
}
declare function createOrResumeReview(request: CreateReviewRequest, dependencies?: ReviewActionDependencies): CreateReviewResult;
declare function refreshReview(request: RefreshReviewRequest): CreateReviewResult;
declare function applyReviewAnalysis(request: ApplyReviewAnalysisRequest): ReviewRef;
declare function listReviews(root: string): ReviewWorkspace[];
declare function openReview(root: string, reference: ReviewRef, dependencies?: OpenReviewDependencies): Promise<string>;
declare function getReviewStatus(request: ReviewStatusRequest): ReviewStatusResult;
declare function formatReviewStatusJson(request: ReviewStatusRequest): string;
declare function printReviewStatus(request: ReviewStatusRequest): string;

interface ReviewCreateFlags {
    root?: string;
    pr?: string;
    staged?: boolean;
    unstaged?: boolean;
    scope?: string;
    json?: boolean;
}
interface ReviewCliDependencies {
    openReview?: typeof openReview;
}
declare function createReviewSourceFromFlags(flags: ReviewCreateFlags): ReviewCaptureSourceRequest;
declare function registerReviewCommands(cli: CAC, dependencies?: ReviewCliDependencies): void;

export { type ApplyReviewAnalysisRequest, type CreateReviewRequest, type CreateReviewResult, type LogArgs, PREVIEW_PORT, type PhaseSetArgs, type PreviewStartOptions, type PreviewStatus, type PreviewTimings, type ProgressArgs, type ProjectPaths, type RefreshReviewRequest, type ResumeArgs, type ReviewActionDependencies, type ReviewAnalysis, type ReviewStatusRequest, type ReviewStatusResult, applyReviewAnalysis, createOrResumeReview, createReviewSourceFromFlags, formatReviewStatusJson, getReviewStatus, initProject, listReviews, logFinding, openReview, phaseSet, previewStart, previewStatus, previewStop, printProgress, printReviewStatus, printStatus, refreshReview, registerReviewCommands, resolveProjectPaths, resumeSet };
