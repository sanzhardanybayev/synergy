import type { AnalysisPolicy, ReviewBundle, ReviewReadiness } from '@synergy/review-core';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ReviewHeader } from '../src/review/ReviewHeader.js';

const READINESS: ReviewReadiness = {
  ready: true,
  preparing: false,
  pending: 0,
  stale: 0,
  unanswered: 0,
  sourceChanged: false,
};

function bundleFor(
  excludes: string[] | undefined,
  analysisPolicy?: AnalysisPolicy,
  insightsAnalysisPolicy?: AnalysisPolicy,
): ReviewBundle {
  return {
    workspace: {
      schemaVersion: 1,
      id: 'workspace-1',
      repository: { root: '/repo', name: 'repo' },
      source: { kind: 'staged', headSha: 'abc', ...(excludes ? { excludes } : {}) },
      currentRevisionId: 'rev-1',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      ...(analysisPolicy ? { analysisPolicy } : {}),
    },
    snapshot: {
      schemaVersion: 1,
      revisionId: 'rev-1',
      source: { kind: 'staged', headSha: 'abc', ...(excludes ? { excludes } : {}) },
      fingerprint: 'fp',
      createdAt: '2026-01-01T00:00:00.000Z',
      kind: 'diff',
      files: [],
      items: [],
    },
    insights: {
      schemaVersion: 1,
      revisionId: 'rev-1',
      groups: [],
      items: [],
      ...(insightsAnalysisPolicy ? { analysisPolicy: insightsAnalysisPolicy } : {}),
    },
    progress: { schemaVersion: 1, updatedAt: '2026-01-01T00:00:00.000Z', items: {} },
    questions: [],
    answers: [],
    sourceChanged: false,
  };
}

describe('ReviewHeader excluded fact', () => {
  it('omits the Excluded fact when the source carries no excludes', () => {
    render(
      <ReviewHeader bundle={bundleFor(undefined)} readiness={READINESS} captureFailed={false} />,
    );
    expect(screen.queryByText('Excluded')).toBeNull();
  });

  it('shows the exclude patterns so the reviewer sees what was dropped from the source', () => {
    render(
      <ReviewHeader
        bundle={bundleFor(['.vouch', 'dist'])}
        readiness={READINESS}
        captureFailed={false}
      />,
    );
    expect(screen.getByText('Excluded')).toBeInTheDocument();
    expect(screen.getByText('.vouch, dist')).toBeInTheDocument();
  });
});

describe('ReviewHeader removals fact', () => {
  it('reports explanations optional when the policy is off (including the absent/legacy case)', () => {
    render(
      <ReviewHeader
        bundle={bundleFor(undefined, { explainRemovals: false })}
        readiness={READINESS}
        captureFailed={false}
      />,
    );
    expect(screen.getByText('Removals')).toBeInTheDocument();
    expect(screen.getByText('Explanations optional')).toBeInTheDocument();
  });

  it('reports explanations optional when the workspace predates analysisPolicy entirely', () => {
    render(
      <ReviewHeader bundle={bundleFor(undefined)} readiness={READINESS} captureFailed={false} />,
    );
    expect(screen.getByText('Explanations optional')).toBeInTheDocument();
  });

  it('reports explanations required when the policy is on', () => {
    render(
      <ReviewHeader
        bundle={bundleFor(undefined, { explainRemovals: true })}
        readiness={READINESS}
        captureFailed={false}
      />,
    );
    expect(screen.getByText('Explanations required')).toBeInTheDocument();
  });

  it('prefers the policy stamped on insights at finalize time over a workspace policy that later changed', () => {
    render(
      <ReviewHeader
        bundle={bundleFor(undefined, { explainRemovals: false }, { explainRemovals: true })}
        readiness={READINESS}
        captureFailed={false}
      />,
    );
    expect(screen.getByText('Explanations required')).toBeInTheDocument();
  });
});
