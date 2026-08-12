import { buildDiffSnapshot } from '@synergy/review-core';
import type { RemovalRationale } from '@synergy/review-core';
import { describe, expect, it } from 'vitest';
import {
  MAX_MOVED_TO_LINES,
  assertCompleteRemovalCoverage,
  resolveRemovalExcerpts,
} from './review-removals.js';

const SOURCE = { kind: 'staged' as const, headSha: 'abc123' };

function buildFixtureSnapshot() {
  const patch = [
    'diff --git a/src/a.ts b/src/a.ts',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -40,12 +40,8 @@',
    ' keep0',
    '-r41',
    '-r42',
    '-r43',
    ' c44',
    ' c45',
    ' c46',
    ' c47',
    ' c48',
    ' c49',
    '-r50',
    ' tail',
  ].join('\n');
  return buildDiffSnapshot({
    revisionId: 'revision-removal-coverage',
    source: SOURCE,
    fingerprint: 'fingerprint-removal-coverage',
    createdAt: '2026-08-12T10:00:00.000Z',
    patch,
  });
}

const scopeSnapshot = {
  schemaVersion: 1 as const,
  kind: 'scope' as const,
  revisionId: 'revision-scope',
  source: { kind: 'scope' as const, patterns: ['src'], headSha: 'abc123' },
  fingerprint: 'fingerprint-scope',
  createdAt: '2026-08-12T10:00:00.000Z',
  items: [],
  files: [],
};

describe('assertCompleteRemovalCoverage', () => {
  const snapshot = buildFixtureSnapshot();
  const itemId = snapshot.items[0]!.id;

  const covered: RemovalRationale[] = [
    {
      reviewItemId: itemId,
      run: { path: 'src/a.ts', start: 41, end: 43 },
      reason: 'dead-code',
      description: 'Unreachable since v2.',
    },
    {
      reviewItemId: itemId,
      run: { path: 'src/a.ts', start: 50, end: 50 },
      reason: 'moved',
      description: 'Moved to the interceptor.',
      movedTo: { path: 'src/b.ts', start: 88, end: 89 },
    },
  ];

  it('accepts a payload covering every derived run', () => {
    expect(() => assertCompleteRemovalCoverage(snapshot, covered)).not.toThrow();
  });

  it('lists every uncovered run', () => {
    expect(() => assertCompleteRemovalCoverage(snapshot, [covered[0]!])).toThrow(
      /src\/a\.ts:50-50/,
    );
  });

  it('rejects a run that does not match a derived run exactly', () => {
    const drifted = [
      { ...covered[0]!, run: { path: 'src/a.ts', start: 41, end: 42 } },
      covered[1]!,
    ];
    expect(() => assertCompleteRemovalCoverage(snapshot, drifted)).toThrow(
      /does not match a captured removal run/,
    );
  });

  it('rejects a relocating reason with no movedTo', () => {
    const { movedTo: _movedTo, ...withoutMovedTo } = covered[1]!;
    const missing = [covered[0]!, withoutMovedTo];
    expect(() => assertCompleteRemovalCoverage(snapshot, missing)).toThrow(/requires movedTo/);
  });

  it('rejects a non-relocating reason that carries movedTo', () => {
    const extra = [
      { ...covered[0]!, movedTo: { path: 'src/b.ts', start: 1, end: 2 } },
      covered[1]!,
    ];
    expect(() => assertCompleteRemovalCoverage(snapshot, extra)).toThrow(/must not carry movedTo/);
  });

  it('rejects a rationale naming a review item that does not own the matched run', () => {
    const wrongOwner = [{ ...covered[0]!, reviewItemId: 'not-the-owner' }, covered[1]!];
    expect(() => assertCompleteRemovalCoverage(snapshot, wrongOwner)).toThrow(/belongs to/);
  });

  it('rejects a duplicate rationale for one run', () => {
    expect(() => assertCompleteRemovalCoverage(snapshot, [...covered, covered[0]!])).toThrow(
      /duplicate removal rationale/,
    );
  });

  it('rejects a reversed or oversized movedTo span', () => {
    const reversed = [
      covered[0]!,
      { ...covered[1]!, movedTo: { path: 'src/b.ts', start: 9, end: 2 } },
    ];
    expect(() => assertCompleteRemovalCoverage(snapshot, reversed)).toThrow(/reversed range/);

    const oversized = [
      covered[0]!,
      { ...covered[1]!, movedTo: { path: 'src/b.ts', start: 1, end: 1 + MAX_MOVED_TO_LINES } },
    ];
    expect(() => assertCompleteRemovalCoverage(snapshot, oversized)).toThrow(
      new RegExp(`at most ${MAX_MOVED_TO_LINES} lines`),
    );
  });

  it('is a no-op for a scope snapshot', () => {
    expect(() => assertCompleteRemovalCoverage(scopeSnapshot, [])).not.toThrow();
  });
});

describe('resolveRemovalExcerpts', () => {
  const snapshot = buildFixtureSnapshot();
  const itemId = snapshot.items[0]!.id;

  // Lands on the same hunk's new-side lines (42-43 map to context rows c45/c46), so it
  // resolves in-review and must not gain a persisted excerpt.
  const movedInsideRationale: RemovalRationale = {
    reviewItemId: itemId,
    run: { path: 'src/a.ts', start: 41, end: 41 },
    reason: 'moved',
    description: 'Moved within the same file.',
    movedTo: { path: 'src/a.ts', start: 42, end: 43 },
  };

  const movedOutsideRationale: RemovalRationale = {
    reviewItemId: itemId,
    run: { path: 'src/a.ts', start: 50, end: 50 },
    reason: 'moved',
    description: 'Moved to the interceptor.',
    movedTo: { path: 'src/b.ts', start: 88, end: 89 },
  };

  const danglingPathRationale: RemovalRationale = {
    reviewItemId: itemId,
    run: { path: 'src/a.ts', start: 50, end: 50 },
    reason: 'moved',
    description: 'Moved to a file that does not exist at the source.',
    movedTo: { path: 'src/missing.ts', start: 1, end: 2 },
  };

  // readTargetLines returns the whole file (as the real git/fs-backed reader does), so the
  // fixture must be long enough to contain absolute lines 88-89 - not just those two lines.
  const bFileLines = [
    ...Array.from({ length: 87 }, (_, index) => `filler${index + 1}`),
    'line88',
    'line89',
  ];
  const io = {
    readTargetLines: (path: string) => (path === 'src/b.ts' ? bFileLines : undefined),
  };

  it('attaches an excerpt for a target outside the review', () => {
    const [resolved] = resolveRemovalExcerpts(snapshot, [movedOutsideRationale], io);
    expect(resolved?.movedToExcerpt).toEqual({
      path: 'src/b.ts',
      start: 88,
      lines: ['line88', 'line89'],
    });
  });

  it('attaches no excerpt when the target is a captured review item', () => {
    const [resolved] = resolveRemovalExcerpts(snapshot, [movedInsideRationale], io);
    expect(resolved?.movedToExcerpt).toBeUndefined();
  });

  it('rejects a target whose file cannot be read', () => {
    expect(() => resolveRemovalExcerpts(snapshot, [danglingPathRationale], io)).toThrow(
      /movedTo target was not found/,
    );
  });

  it('rejects a target range past the end of the file', () => {
    const io2 = { readTargetLines: () => ['only one line'] };
    expect(() => resolveRemovalExcerpts(snapshot, [movedOutsideRationale], io2)).toThrow(
      /is out of range/,
    );
  });
});
