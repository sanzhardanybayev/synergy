import { StatusValue } from '@synergy/state';
import { ReviewInsightConfidence, ReviewGroup, ReviewItemInsight, createReviewStore, applyCodeSections, ReviewRef, CaptureReviewSourceRequest, compareReviewSourceFreshness, deriveReviewReadiness, ReviewWorkspace, ReviewCaptureSourceRequest } from '@synergy/review-core';
export { CaptureReviewSourceRequest, CapturedReviewSource, CommandResult, CommandRunner, capturePr, captureReviewSource, captureScope, captureStaged, captureUnstaged } from '@synergy/review-core';
import { CAC } from 'cac';

declare function initProject(root?: string): {
    synergyDir: string;
};

interface PreviewTimings {
    lockMs: number;
    launchMs: number;
    listenMs: number;
    healthMs: number;
    totalMs: number;
}

interface PreviewStartOptions {
    root?: string;
    port?: number;
    background?: boolean;
    quiet?: boolean;
}
interface PreviewStopOptions {
    quiet?: boolean;
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
declare function previewStop(root?: string, options?: PreviewStopOptions): Promise<boolean>;
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

interface ReviewAnalysisGuidance {
    textFiles: number;
    textLines: number;
    minimumSections: number;
    targetSections: number;
    maximumSections: number;
    scopeTooBroad: boolean;
}

interface ScopeAnalysisSectionInput {
    key: string;
    path: string;
    label: string;
    parentLabel?: string;
    start: number;
    end: number;
    description: string;
    confidence: ReviewInsightConfidence;
    evidencePaths: string[];
}
interface ScopeAnalysisGroupInput {
    id: string;
    label: string;
    sectionKeys: string[];
    intro?: string;
}
interface FileAnalysisInput {
    path: string;
    description: string;
    confidence: ReviewInsightConfidence;
}
type ReviewAnalysisInput = {
    kind: 'scope';
    groups: ScopeAnalysisGroupInput[];
    sections: ScopeAnalysisSectionInput[];
    files?: FileAnalysisInput[];
    summary?: string;
} | {
    kind: 'diff';
    groups: ReviewGroup[];
    items: ReviewItemInsight[];
    files?: FileAnalysisInput[];
    summary?: string;
};
declare function parseReviewAnalysisInput(value: unknown): ReviewAnalysisInput;

interface CreateReviewRequest extends CaptureReviewSourceRequest {
}
interface CreateReviewResult {
    reference: ReviewRef;
    resumed: boolean;
    url: string;
    analysisRequired: boolean;
    analysisGuidance?: ReviewAnalysisGuidance;
}
interface ReviewActionDependencies {
    createStore?: typeof createReviewStore;
}
interface ApplyReviewAnalysisDependencies {
    createStore?: typeof createReviewStore;
    applyCodeSections?: typeof applyCodeSections;
    previewStatus?: typeof previewStatus;
    now?: () => Date;
    monotonicNow?: () => number;
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
interface ApplyReviewAnalysisRequest {
    root: string;
    reference: ReviewRef;
    analysis: ReviewAnalysisInput;
    parsingInMs?: number;
    commandStartedAt?: number;
}
interface ReviewAnalysisTimings {
    parsingMs: number;
    derivationMs: number;
    validationMs: number;
    publicationMs: number;
    previewResolutionMs: number;
    totalMs: number;
}
interface ReviewAnalysisSetResult {
    reference: string;
    analysisFinalized: true;
    reviewItemCount: number;
    groupCount: number;
    withinRecommendedRange: boolean;
    analysisFinalizedInMs: number;
    route: string;
    previewReady: boolean;
    url?: string;
    timings: ReviewAnalysisTimings;
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
    analysisGuidance?: ReviewAnalysisGuidance;
}
declare function createOrResumeReview(request: CreateReviewRequest, dependencies?: ReviewActionDependencies): CreateReviewResult;
declare function refreshReview(request: RefreshReviewRequest): CreateReviewResult;
declare function applyReviewAnalysis(request: ApplyReviewAnalysisRequest, dependencies?: ApplyReviewAnalysisDependencies): Promise<ReviewAnalysisSetResult>;
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
    applyReviewAnalysis?: typeof applyReviewAnalysis;
    monotonicNow?: () => number;
}
declare function createReviewSourceFromFlags(flags: ReviewCreateFlags): ReviewCaptureSourceRequest;
declare function registerReviewCommands(cli: CAC, dependencies?: ReviewCliDependencies): void;

export { type ApplyReviewAnalysisDependencies, type ApplyReviewAnalysisRequest, type CreateReviewRequest, type CreateReviewResult, type LogArgs, PREVIEW_PORT, type PhaseSetArgs, type PreviewStartOptions, type PreviewStatus, type PreviewStopOptions, type PreviewTimings, type ProgressArgs, type ProjectPaths, type RefreshReviewRequest, type ResumeArgs, type ReviewActionDependencies, type ReviewAnalysisInput, type ReviewAnalysisSetResult, type ReviewAnalysisTimings, type ReviewStatusRequest, type ReviewStatusResult, type ScopeAnalysisGroupInput, type ScopeAnalysisSectionInput, applyReviewAnalysis, createOrResumeReview, createReviewSourceFromFlags, formatReviewStatusJson, getReviewStatus, initProject, listReviews, logFinding, openReview, parseReviewAnalysisInput, phaseSet, previewStart, previewStatus, previewStop, printProgress, printReviewStatus, printStatus, refreshReview, registerReviewCommands, resolveProjectPaths, resumeSet };
