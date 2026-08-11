import type {
  DiffReviewSnapshot,
  ReviewBundle,
  ReviewQuestion,
  ReviewReadiness,
  ReviewRef,
  ScopeReviewSnapshot,
} from '@synergy/review-core';
import { resolveBrowserReviewItemContext } from '@synergy/review-core/browser';
import { vi } from 'vitest';
import type { ReviewClient } from '../src/review/ReviewProvider.js';

export const REVIEW_REFERENCE: ReviewRef = {
  workspaceId: 'mobile-app-pr-317',
  revisionId: 'base123-head456',
};

const NOW = '2026-07-19T10:00:00.000Z';
const SOURCE = {
  kind: 'pr' as const,
  number: 317,
  url: 'https://github.com/foody-ai/mobile-app/pull/317',
  baseSha: 'base123',
  headSha: 'head456',
};

const DIFF_SNAPSHOT: DiffReviewSnapshot = {
  schemaVersion: 1,
  revisionId: REVIEW_REFERENCE.revisionId,
  source: SOURCE,
  fingerprint: 'diff-fingerprint',
  createdAt: NOW,
  kind: 'diff',
  files: [
    {
      path: 'features/plan/PlanCardToggle.tsx',
      status: 'modified',
      additions: 1,
      deletions: 1,
      binary: false,
      hunks: [
        {
          reviewItemId: 'hunk-theme',
          reviewItemContentHash: 'theme-content',
          reviewItemLocationHash: 'theme-location',
          header: '@@ -17,1 +17,1 @@',
          oldStart: 17,
          oldLines: 1,
          newStart: 17,
          newLines: 1,
          lines: [
            { kind: 'remove', oldLine: 17, newLine: null, text: 'bg-background' },
            { kind: 'add', oldLine: null, newLine: 17, text: 'bg-primary-surface' },
          ],
        },
      ],
    },
    {
      path: 'features/track-meal/EditBottomSheet.tsx',
      status: 'modified',
      additions: 2,
      deletions: 0,
      binary: false,
      hunks: [
        {
          reviewItemId: 'hunk-sheet',
          reviewItemContentHash: 'sheet-content',
          reviewItemLocationHash: 'sheet-location',
          header: '@@ -224,1 +224,2 @@',
          oldStart: 224,
          oldLines: 1,
          newStart: 224,
          newLines: 2,
          lines: [
            { kind: 'context', oldLine: 224, newLine: 224, text: '<BottomSheetModal' },
            { kind: 'add', oldLine: null, newLine: 225, text: 'enableDynamicSizing' },
          ],
        },
      ],
    },
  ],
  items: [
    {
      id: 'hunk-theme',
      kind: 'hunk',
      path: 'features/plan/PlanCardToggle.tsx',
      label: '@@ -17,1 +17,1 @@',
      range: { start: 17, end: 17 },
      contentHash: 'theme-content',
      locationHash: 'theme-location',
    },
    {
      id: 'hunk-sheet',
      kind: 'hunk',
      path: 'features/track-meal/EditBottomSheet.tsx',
      label: '@@ -224,1 +224,2 @@',
      range: { start: 224, end: 225 },
      contentHash: 'sheet-content',
      locationHash: 'sheet-location',
    },
  ],
};

export function makeDiffBundle(overrides: Partial<ReviewBundle> = {}): ReviewBundle {
  return {
    workspace: {
      schemaVersion: 1,
      id: REVIEW_REFERENCE.workspaceId,
      repository: { root: '/repo', name: 'mobile-app' },
      source: SOURCE,
      currentRevisionId: REVIEW_REFERENCE.revisionId,
      createdAt: NOW,
      updatedAt: NOW,
    },
    snapshot: DIFF_SNAPSHOT,
    insights: {
      schemaVersion: 1,
      revisionId: REVIEW_REFERENCE.revisionId,
      groups: [
        { id: 'theme', label: 'Theme and surfaces', reviewItemIds: ['hunk-theme'] },
        { id: 'sheets', label: 'Screen and sheet adaptations', reviewItemIds: ['hunk-sheet'] },
      ],
      items: [
        {
          reviewItemId: 'hunk-theme',
          description:
            'Uses the nutrition-plan surface token so Android elevation keeps the intended card hierarchy.',
          confidence: 'high',
          evidencePaths: ['theme/tokens/colors.ts'],
        },
        {
          reviewItemId: 'hunk-sheet',
          description:
            'Lets the meal editor measure its content so the modal opens to a usable height on Android.',
          confidence: 'low',
          evidencePaths: ['features/track-meal/EditBottomSheet.tsx'],
        },
      ],
    },
    progress: {
      schemaVersion: 1,
      updatedAt: NOW,
      items: {
        'hunk-theme': { status: 'needs-review' },
        'hunk-sheet': { status: 'needs-review' },
      },
    },
    questions: [],
    answers: [],
    sourceChanged: false,
    ...overrides,
  };
}

export function makeScopeBundle(): ReviewBundle {
  const snapshot: ScopeReviewSnapshot = {
    schemaVersion: 1,
    revisionId: 'scope-revision',
    source: { kind: 'scope', patterns: ['features/subscriptions'], headSha: 'head456' },
    fingerprint: 'scope-fingerprint',
    createdAt: NOW,
    kind: 'scope',
    files: [
      {
        path: 'features/subscriptions/useSubscription.ts',
        binary: false,
        lines: [
          { number: 1, text: "import { useQuery } from '@tanstack/react-query';" },
          { number: 2, text: '' },
          { number: 3, text: 'export function useSubscription() {' },
          { number: 4, text: "  return useQuery({ queryKey: ['subscription'] });" },
          { number: 5, text: '}' },
          { number: 6, text: '' },
          { number: 7, text: 'export const plan = true;' },
        ],
      },
    ],
    items: [
      {
        id: 'section-hook',
        kind: 'code-section',
        path: 'features/subscriptions/useSubscription.ts',
        label: 'useSubscription',
        range: { start: 3, end: 5 },
        contentHash: 'scope-content',
        locationHash: 'scope-location',
      },
    ],
  };
  return {
    workspace: {
      schemaVersion: 1,
      id: 'mobile-app-scope-subscriptions',
      repository: { root: '/repo', name: 'mobile-app' },
      source: snapshot.source,
      currentRevisionId: snapshot.revisionId,
      createdAt: NOW,
      updatedAt: NOW,
    },
    snapshot,
    insights: {
      schemaVersion: 1,
      revisionId: snapshot.revisionId,
      groups: [
        { id: 'subscriptions', label: 'Subscription access', reviewItemIds: ['section-hook'] },
      ],
      items: [
        {
          reviewItemId: 'section-hook',
          description: 'Loads the entitlement state consumed by subscription-gated screens.',
          confidence: 'high',
          evidencePaths: ['features/subscriptions/screens/Paywall.tsx'],
        },
      ],
    },
    progress: {
      schemaVersion: 1,
      updatedAt: NOW,
      items: { 'section-hook': { status: 'needs-review' } },
    },
    questions: [],
    answers: [],
    sourceChanged: false,
  };
}

function readiness(bundle: ReviewBundle): ReviewReadiness {
  const statuses = bundle.snapshot.items.map((item) => bundle.progress.items[item.id]?.status);
  return {
    ready: false,
    preparing: false,
    pending: statuses.filter((status) => !status || status === 'needs-review').length,
    stale: statuses.filter((status) => status === 'stale').length,
    unanswered: bundle.questions.filter((question) => question.status !== 'answered').length,
    sourceChanged: bundle.sourceChanged,
  };
}

export function makeReviewClient(
  initialBundle: ReviewBundle = makeDiffBundle(),
  overrides: Partial<ReviewClient> = {},
): ReviewClient {
  return {
    getBundle: vi.fn().mockResolvedValue({
      bundle: initialBundle,
      readiness: readiness(initialBundle),
      analysisFinalized: true,
    }),
    patchProgress: vi.fn().mockResolvedValue({
      bundle: initialBundle,
      readiness: readiness(initialBundle),
      analysisFinalized: true,
    }),
    postQuestion: vi
      .fn()
      .mockImplementation(
        async (
          reference: ReviewRef,
          reviewItemId: string,
          selectedLineIds: string[],
          body: string,
        ) => {
          const itemContext = resolveBrowserReviewItemContext(initialBundle.snapshot, reviewItemId);
          const question: ReviewQuestion = {
            schemaVersion: 1,
            id: 'question-new',
            workspaceId: reference.workspaceId,
            revisionId: reference.revisionId,
            path: itemContext.item.path,
            reviewItemId,
            selection: { kind: initialBundle.snapshot.kind, selectedLineIds },
            itemContext,
            description:
              initialBundle.insights.items.find((item) => item.reviewItemId === reviewItemId)
                ?.description ?? '',
            body,
            createdAt: NOW,
            generation: 0,
            status: 'queued',
          };
          const next = { ...initialBundle, questions: [...initialBundle.questions, question] };
          return { question, bundle: next, readiness: readiness(next), analysisFinalized: true };
        },
      ),
    postActive: vi.fn().mockResolvedValue(undefined),
    patchWalkthrough: vi.fn().mockResolvedValue({
      bundle: initialBundle,
      readiness: readiness(initialBundle),
      analysisFinalized: true,
    }),
    openStream: vi.fn().mockReturnValue({ close: vi.fn() }),
    ...overrides,
  };
}

export function firstDiffRowId(bundle: ReviewBundle = makeDiffBundle()): string {
  return resolveBrowserReviewItemContext(bundle.snapshot, 'hunk-theme').rows[0]!.id;
}

export function addedDiffRowId(bundle: ReviewBundle = makeDiffBundle()): string {
  return resolveBrowserReviewItemContext(bundle.snapshot, 'hunk-theme').rows[1]!.id;
}

/**
 * Matches a rendered code line by its full text.
 *
 * Highlighted lines split into token spans, so Testing Library's default matcher - which reads only
 * an element's direct text-node children - no longer sees the line on the `<code>` element. This
 * matcher compares `textContent` and rejects ancestors so exactly one element matches.
 */
export function codeLineText(expected: string) {
  return (_content: string, element: Element | null): boolean =>
    element?.tagName === 'CODE' && element.textContent === expected;
}
