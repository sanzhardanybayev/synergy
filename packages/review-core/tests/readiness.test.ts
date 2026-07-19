import { describe, expect, it } from 'vitest';
import {
  type ReviewBundle,
  type ReviewItem,
  type ReviewQuestion,
  buildDiffSnapshot,
  deriveReviewReadiness,
} from '../src/index.js';

const NOW = '2026-07-19T12:00:00.000Z';
const SOURCE = { kind: 'staged' as const, headSha: 'abc1234' };

function makeItem(id: string): ReviewItem {
  return {
    id,
    kind: 'hunk',
    path: 'src/example.ts',
    label: '@@ -1 +1 @@',
    range: { start: 1, end: 1 },
    contentHash: `content-${id}`,
    locationHash: `location-${id}`,
  };
}

function makeQuestion(
  status: ReviewQuestion['status'],
  overrides: Partial<ReviewQuestion> = {},
): ReviewQuestion {
  return {
    schemaVersion: 1,
    id: `question-${status}`,
    workspaceId: 'mobile-app-staged',
    revisionId: 'current-revision',
    path: 'src/example.ts',
    reviewItemId: 'item-a',
    selection: { kind: 'diff', selectedLineIds: ['row-item-a'] },
    itemContext: {
      item: makeItem('item-a'),
      rows: [
        {
          id: 'row-item-a',
          kind: 'add',
          oldLine: null,
          newLine: 1,
          text: 'export const example = true;',
        },
      ],
    },
    description: 'Adds the example.',
    body: 'What does this do?',
    createdAt: NOW,
    status,
    ...overrides,
  };
}

function makeBundle(overrides: Partial<ReviewBundle> = {}): ReviewBundle {
  const item = makeItem('item-a');
  return {
    workspace: {
      schemaVersion: 1,
      id: 'mobile-app-staged',
      repository: { root: '/workspace/mobile-app', name: 'mobile-app' },
      source: SOURCE,
      currentRevisionId: 'current-revision',
      createdAt: NOW,
      updatedAt: NOW,
    },
    snapshot: {
      schemaVersion: 1,
      revisionId: 'current-revision',
      source: SOURCE,
      fingerprint: 'fingerprint-current',
      createdAt: NOW,
      kind: 'diff',
      files: [],
      items: [item],
    },
    insights: { schemaVersion: 1, revisionId: 'current-revision', groups: [], items: [] },
    progress: {
      schemaVersion: 1,
      updatedAt: NOW,
      items: { 'item-a': { status: 'reviewed', reviewedAt: NOW } },
    },
    questions: [],
    answers: [],
    sourceChanged: false,
    ...overrides,
  };
}

describe('review readiness', () => {
  it('is ready when every item is reviewed or carried forward and every question is answered', () => {
    const firstItem = makeItem('item-a');
    const carriedItem = makeItem('item-b');
    const bundle = makeBundle({
      snapshot: { ...makeBundle().snapshot, items: [firstItem, carriedItem] },
      progress: {
        schemaVersion: 1,
        updatedAt: NOW,
        items: {
          'item-a': { status: 'reviewed', reviewedAt: NOW },
          'item-b': {
            status: 'carried-forward',
            inheritedFrom: { revisionId: 'old-revision', reviewItemId: 'old-item-b' },
            reviewedAt: NOW,
          },
        },
      },
      questions: [makeQuestion('answered')],
    });

    expect(deriveReviewReadiness(bundle)).toEqual({
      ready: true,
      preparing: false,
      pending: 0,
      stale: 0,
      unanswered: 0,
      sourceChanged: false,
    });
  });

  it('counts missing and needs-review states as pending without counting stale items twice', () => {
    const bundle = makeBundle({
      snapshot: {
        ...makeBundle().snapshot,
        items: [makeItem('item-a'), makeItem('item-b'), makeItem('item-c')],
      },
      progress: {
        schemaVersion: 1,
        updatedAt: NOW,
        items: {
          'item-a': { status: 'needs-review' },
          'item-b': { status: 'stale' },
        },
      },
    });

    expect(deriveReviewReadiness(bundle)).toEqual({
      ready: false,
      preparing: false,
      pending: 2,
      stale: 1,
      unanswered: 0,
      sourceChanged: false,
    });
  });

  it('blocks readiness for queued or claimed questions until each is answered', () => {
    const bundle = makeBundle({
      questions: [
        makeQuestion('queued'),
        makeQuestion('processing', {
          id: 'question-claimed',
          claim: {
            listenerId: 'agent-a',
            token: 'claim-token',
            claimedAt: NOW,
            expiresAt: '2026-07-19T12:15:00.000Z',
          },
        }),
      ],
    });

    expect(deriveReviewReadiness(bundle)).toMatchObject({ ready: false, unanswered: 2 });
  });

  it('blocks readiness when the displayed snapshot is no longer current', () => {
    expect(deriveReviewReadiness(makeBundle({ sourceChanged: true }))).toEqual({
      ready: false,
      preparing: false,
      pending: 0,
      stale: 0,
      unanswered: 0,
      sourceChanged: true,
    });
  });

  it('counts a zero-line file change alongside code hunks in mixed review readiness', () => {
    const snapshot = buildDiffSnapshot({
      revisionId: 'current-revision',
      source: SOURCE,
      fingerprint: 'mixed-fingerprint',
      createdAt: NOW,
      patch: [
        'diff --git a/src/example.ts b/src/example.ts',
        '--- a/src/example.ts',
        '+++ b/src/example.ts',
        '@@ -1 +1 @@',
        '-before',
        '+after',
        'diff --git a/assets/logo.png b/assets/logo.png',
        'Binary files a/assets/logo.png and b/assets/logo.png differ',
      ].join('\n'),
    });
    const hunkItem = snapshot.items.find((item) => item.kind === 'hunk');
    if (!hunkItem) throw new Error('mixed fixture is missing its hunk');
    const bundle = makeBundle({
      snapshot,
      progress: {
        schemaVersion: 1,
        updatedAt: NOW,
        items: { [hunkItem.id]: { status: 'reviewed', reviewedAt: NOW } },
      },
    });

    expect(snapshot.items.map((item) => item.kind)).toEqual(['hunk', 'file']);
    expect(deriveReviewReadiness(bundle)).toMatchObject({ ready: false, pending: 1 });
  });

  it('keeps an unfinalized analysis in a preparing state even when it has no items', () => {
    const pending = makeBundle({
      snapshot: { ...makeBundle().snapshot, items: [] },
      progress: { schemaVersion: 1, updatedAt: NOW, items: {} },
    });

    expect(deriveReviewReadiness(pending, false)).toEqual({
      ready: false,
      preparing: true,
      pending: 0,
      stale: 0,
      unanswered: 0,
      sourceChanged: false,
    });
  });
});
