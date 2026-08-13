import { describe, expect, it } from 'vitest';
import { assertReviewInsights, assertReviewWorkspace } from '../src/index.js';

function baseWorkspace(source: Record<string, unknown>) {
  return {
    schemaVersion: 1,
    id: 'workspace-1',
    repository: { root: '/repo', name: 'repo' },
    source,
    currentRevisionId: 'rev-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('review source excludes', () => {
  it('validates a source with no excludes field (backward compatibility)', () => {
    expect(() =>
      assertReviewWorkspace(baseWorkspace({ kind: 'staged', headSha: 'abc' })),
    ).not.toThrow();
  });

  it('validates each source kind with an excludes array', () => {
    expect(() =>
      assertReviewWorkspace(
        baseWorkspace({
          kind: 'pr',
          number: 1,
          url: 'https://github.com/acme/repo/pull/1',
          baseSha: 'a',
          headSha: 'b',
          excludes: ['.vouch'],
        }),
      ),
    ).not.toThrow();
    expect(() =>
      assertReviewWorkspace(
        baseWorkspace({ kind: 'staged', headSha: 'abc', excludes: ['.vouch'] }),
      ),
    ).not.toThrow();
    expect(() =>
      assertReviewWorkspace(
        baseWorkspace({ kind: 'unstaged', headSha: 'abc', excludes: ['.vouch'] }),
      ),
    ).not.toThrow();
    expect(() =>
      assertReviewWorkspace(
        baseWorkspace({
          kind: 'scope',
          patterns: ['src'],
          headSha: 'abc',
          excludes: ['.vouch'],
        }),
      ),
    ).not.toThrow();
  });

  it('rejects a non-string entry in excludes', () => {
    expect(() =>
      assertReviewWorkspace(baseWorkspace({ kind: 'staged', headSha: 'abc', excludes: [1] })),
    ).toThrow();
  });
});

describe('assertReviewInsights narrative fields', () => {
  it('accepts insights with optional summary and group intro', () => {
    const insights = {
      schemaVersion: 1,
      revisionId: 'rev-1',
      summary: 'The story of this change.',
      groups: [{ id: 'core', label: 'Core', intro: 'Start here.', reviewItemIds: ['item-1'] }],
      items: [
        {
          reviewItemId: 'item-1',
          description: 'Does a thing.',
          confidence: 'high',
          evidencePaths: ['src/a.ts'],
        },
      ],
    };
    expect(() => assertReviewInsights(insights)).not.toThrow();
  });

  it('still accepts insights without narrative fields', () => {
    const insights = {
      schemaVersion: 1,
      revisionId: 'rev-1',
      groups: [{ id: 'core', label: 'Core', reviewItemIds: ['item-1'] }],
      items: [
        {
          reviewItemId: 'item-1',
          description: 'Does a thing.',
          confidence: 'high',
          evidencePaths: ['src/a.ts'],
        },
      ],
    };
    expect(() => assertReviewInsights(insights)).not.toThrow();
  });

  it('rejects a blank summary', () => {
    const insights = {
      schemaVersion: 1,
      revisionId: 'rev-1',
      summary: '',
      groups: [{ id: 'core', label: 'Core', reviewItemIds: ['item-1'] }],
      items: [
        {
          reviewItemId: 'item-1',
          description: 'Does a thing.',
          confidence: 'high',
          evidencePaths: ['src/a.ts'],
        },
      ],
    };
    expect(() => assertReviewInsights(insights)).toThrow();
  });
});

const baseInsights = {
  schemaVersion: 1 as const,
  revisionId: 'rev-1',
  groups: [{ id: 'g1', label: 'Group', reviewItemIds: ['item-1'] }],
  items: [
    { reviewItemId: 'item-1', description: 'd', confidence: 'high', evidencePaths: ['a.ts'] },
  ],
};

describe('removal rationale schema', () => {
  it('accepts a moved rationale with a target', () => {
    const value = {
      ...baseInsights,
      removals: [
        {
          reviewItemId: 'item-1',
          run: { path: 'a.ts', start: 41, end: 43 },
          reason: 'moved',
          description: 'Refresh converged into the interceptor.',
          movedTo: { path: 'b.ts', start: 88, end: 91 },
          movedToExcerpt: { path: 'b.ts', start: 88, lines: ['if (x) {', '}'] },
        },
      ],
    };
    expect(() => assertReviewInsights(value)).not.toThrow();
  });

  it('accepts insights with no removals field', () => {
    expect(() => assertReviewInsights(baseInsights)).not.toThrow();
  });

  it('accepts an unclear rationale with no movedTo', () => {
    const value = {
      ...baseInsights,
      removals: [
        {
          reviewItemId: 'item-1',
          run: { path: 'a.ts', start: 41, end: 43 },
          reason: 'unclear',
          description: 'Removed alongside the auth refactor; could not confirm where it landed.',
        },
      ],
    };
    expect(() => assertReviewInsights(value)).not.toThrow();
  });

  it('still accepts a persisted revision written before unclear existed (six-reason payload)', () => {
    const value = {
      ...baseInsights,
      removals: [
        {
          reviewItemId: 'item-1',
          run: { path: 'a.ts', start: 41, end: 43 },
          reason: 'obsolete',
          description: 'Superseded by the new config loader.',
        },
      ],
    };
    expect(() => assertReviewInsights(value)).not.toThrow();
  });

  it('rejects an unknown reason', () => {
    const value = {
      ...baseInsights,
      removals: [
        {
          reviewItemId: 'item-1',
          run: { path: 'a.ts', start: 41, end: 43 },
          reason: 'because',
          description: 'd',
        },
      ],
    };
    expect(() => assertReviewInsights(value)).toThrow();
  });

  it('rejects an unknown property on a rationale', () => {
    const value = {
      ...baseInsights,
      removals: [
        {
          reviewItemId: 'item-1',
          run: { path: 'a.ts', start: 41, end: 43 },
          reason: 'dead-code',
          description: 'd',
          extra: true,
        },
      ],
    };
    expect(() => assertReviewInsights(value)).toThrow();
  });
});
