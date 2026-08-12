import { describe, expect, it } from 'vitest';
import {
  RELOCATING_REMOVAL_REASONS,
  type RemovalRationale,
  buildDiffSnapshot,
  resolveReviewItemContext,
} from '../src/index.js';
import { removalRunHash } from '../src/removal-hash.js';
import {
  buildRemovalStrips,
  deriveRemovalRuns,
  deriveSnapshotRemovalRuns,
  resolveRemovalTarget,
} from '../src/removals.js';
import type { ReviewDiffLineRow } from '../src/types.js';

const SOURCE = { kind: 'staged' as const, headSha: 'abc123' };

const rows: ReviewDiffLineRow[] = [
  { id: 'r0', kind: 'context', oldLine: 40, newLine: 40, text: 'a' },
  { id: 'r1', kind: 'remove', oldLine: 41, newLine: null, text: 'b' },
  { id: 'r2', kind: 'remove', oldLine: 42, newLine: null, text: 'c' },
  { id: 'r3', kind: 'context', oldLine: 43, newLine: 41, text: 'd' },
  { id: 'r4', kind: 'remove', oldLine: 44, newLine: null, text: 'e' },
  { id: 'r5', kind: 'add', oldLine: null, newLine: 42, text: 'f' },
];

describe('deriveRemovalRuns', () => {
  it('splits contiguous removed rows into separate runs', () => {
    expect(deriveRemovalRuns(rows)).toEqual([
      { start: 41, end: 42, lineIds: ['r1', 'r2'], texts: ['b', 'c'] },
      { start: 44, end: 44, lineIds: ['r4'], texts: ['e'] },
    ]);
  });

  it('returns no runs when nothing was removed', () => {
    expect(deriveRemovalRuns(rows.filter((row) => row.kind !== 'remove'))).toEqual([]);
  });
});

describe('removalRunHash', () => {
  it('ignores line numbers and depends only on ordered text', () => {
    expect(removalRunHash(['b', 'c'])).toBe(removalRunHash(['b', 'c']));
    expect(removalRunHash(['b', 'c'])).not.toBe(removalRunHash(['c', 'b']));
  });

  it('is unaffected by a pure line-number offset shift', () => {
    const shifted = rows.map((row) => ({
      ...row,
      oldLine: row.oldLine === null ? null : row.oldLine + 100,
    }));
    const [firstRun] = deriveRemovalRuns(rows);
    const [firstShiftedRun] = deriveRemovalRuns(shifted);
    expect(removalRunHash(firstRun!.texts)).toBe(removalRunHash(firstShiftedRun!.texts));
    expect(firstRun!.start).not.toBe(firstShiftedRun!.start);
  });
});

function buildFixtureSnapshot() {
  const patch = [
    'diff --git a/src/http/client.ts b/src/http/client.ts',
    '--- a/src/http/client.ts',
    '+++ b/src/http/client.ts',
    '@@ -5,4 +5,2 @@',
    ' keep',
    '-moved line one',
    '-moved line two',
    ' tail',
    'diff --git a/src/http/interceptor.ts b/src/http/interceptor.ts',
    '--- a/src/http/interceptor.ts',
    '+++ b/src/http/interceptor.ts',
    '@@ -80,2 +80,4 @@',
    ' before',
    '+moved line one',
    '+moved line two',
    ' after',
  ].join('\n');
  return buildDiffSnapshot({
    revisionId: 'revision-removals',
    source: SOURCE,
    fingerprint: 'fingerprint-removals',
    createdAt: '2026-08-12T10:00:00.000Z',
    patch,
  });
}

describe('deriveSnapshotRemovalRuns', () => {
  it('collects removal runs across every hunk item in a diff snapshot', () => {
    const snapshot = buildFixtureSnapshot();
    const clientItem = snapshot.items[0]!;
    const runs = deriveSnapshotRemovalRuns(snapshot);
    expect(runs).toEqual([
      {
        start: 6,
        end: 7,
        lineIds: expect.any(Array),
        texts: ['moved line one', 'moved line two'],
        reviewItemId: clientItem.id,
        path: 'src/http/client.ts',
      },
    ]);
  });

  it('returns no runs for a scope snapshot', () => {
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
    expect(deriveSnapshotRemovalRuns(scopeSnapshot)).toEqual([]);
  });
});

describe('resolveRemovalTarget', () => {
  it('resolves a target that lands inside a captured item to an in-review jump', () => {
    const snapshot = buildFixtureSnapshot();
    const clientItem = snapshot.items[0]!;
    const interceptorItem = snapshot.items[1]!;
    const interceptorContext = resolveReviewItemContext(snapshot, interceptorItem.id);
    const expectedRowIds = interceptorContext.rows
      .filter(
        (row) =>
          row.kind !== 'scope' && row.newLine !== null && row.newLine >= 81 && row.newLine <= 82,
      )
      .map((row) => row.id);
    expect(expectedRowIds).toHaveLength(2);

    const movedRationale: RemovalRationale = {
      reviewItemId: clientItem.id,
      run: { path: 'src/http/client.ts', start: 6, end: 7 },
      reason: 'moved',
      description: 'Moved into the interceptor.',
      movedTo: { path: 'src/http/interceptor.ts', start: 81, end: 82 },
    };
    expect(RELOCATING_REMOVAL_REASONS).toContain(movedRationale.reason);

    const resolved = resolveRemovalTarget(snapshot, movedRationale);
    expect(resolved).toEqual({
      kind: 'in-review',
      reviewItemId: interceptorItem.id,
      rowIds: expectedRowIds,
      path: 'src/http/interceptor.ts',
      start: 81,
      end: 82,
    });
  });

  it('resolves a target outside the review to its persisted excerpt', () => {
    const snapshot = buildFixtureSnapshot();
    const clientItem = snapshot.items[0]!;
    const excerptRationale: RemovalRationale = {
      reviewItemId: clientItem.id,
      run: { path: 'src/http/client.ts', start: 6, end: 7 },
      reason: 'moved',
      description: 'Moved outside the captured review.',
      movedTo: { path: 'src/other.ts', start: 12, end: 13 },
      movedToExcerpt: { path: 'src/other.ts', start: 12, lines: ['one', 'two'] },
    };

    const resolved = resolveRemovalTarget(snapshot, excerptRationale);
    expect(resolved).toEqual({
      kind: 'excerpt',
      path: 'src/other.ts',
      start: 12,
      lines: ['one', 'two'],
    });
  });

  it('does not resolve a target that only partially overlaps the added lines', () => {
    const snapshot = buildFixtureSnapshot();
    const clientItem = snapshot.items[0]!;
    // The interceptor hunk only adds new lines 81-82 ("+moved line one"/"+moved line two"); line
    // 83 ("after") is unchanged context. A target of 81-83 must not resolve in-review just
    // because *some* of its lines are added rows - every line in the range must be, or the claim
    // silently truncates to whatever happened to be captured.
    const partialRationale: RemovalRationale = {
      reviewItemId: clientItem.id,
      run: { path: 'src/http/client.ts', start: 6, end: 7 },
      reason: 'moved',
      description: 'Claims a move that only partly lands on added lines.',
      movedTo: { path: 'src/http/interceptor.ts', start: 81, end: 83 },
    };
    expect(resolveRemovalTarget(snapshot, partialRationale)).toEqual({ kind: 'unresolved' });
  });

  it('does not resolve a target landing entirely on unchanged context rows', () => {
    const snapshot = buildFixtureSnapshot();
    const clientItem = snapshot.items[0]!;
    // "before" (line 80) is context in the interceptor hunk, not an added row - a moved claim
    // pointing at it would assert code moved to a line that was never added.
    const contextRationale: RemovalRationale = {
      reviewItemId: clientItem.id,
      run: { path: 'src/http/client.ts', start: 6, end: 7 },
      reason: 'moved',
      description: 'Claims a move onto unchanged code.',
      movedTo: { path: 'src/http/interceptor.ts', start: 80, end: 80 },
    };
    expect(resolveRemovalTarget(snapshot, contextRationale)).toEqual({ kind: 'unresolved' });
  });

  it('reports an unresolved target when neither an item nor an excerpt matches', () => {
    const snapshot = buildFixtureSnapshot();
    const clientItem = snapshot.items[0]!;
    const danglingRationale: RemovalRationale = {
      reviewItemId: clientItem.id,
      run: { path: 'src/http/client.ts', start: 6, end: 7 },
      reason: 'moved',
      description: 'Claims a move but nothing backs it up.',
      movedTo: { path: 'src/nope.ts', start: 1, end: 1 },
    };

    expect(resolveRemovalTarget(snapshot, danglingRationale)).toEqual({ kind: 'unresolved' });
  });

  it('reports an unresolved target when the rationale carries no movedTo at all', () => {
    const snapshot = buildFixtureSnapshot();
    const clientItem = snapshot.items[0]!;
    const deadCodeRationale: RemovalRationale = {
      reviewItemId: clientItem.id,
      run: { path: 'src/http/client.ts', start: 6, end: 7 },
      reason: 'dead-code',
      description: 'Unreachable after the refactor.',
    };

    expect(resolveRemovalTarget(snapshot, deadCodeRationale)).toEqual({ kind: 'unresolved' });
  });
});

describe('buildRemovalStrips', () => {
  it('attaches the matching rationale and resolved target to each derived run, in row order', () => {
    const snapshot = buildFixtureSnapshot();
    const clientItem = snapshot.items[0]!;
    const interceptorItem = snapshot.items[1]!;
    const clientContext = resolveReviewItemContext(snapshot, clientItem.id);
    const clientRows = clientContext.rows.filter(
      (row): row is ReviewDiffLineRow => row.kind !== 'scope',
    );
    const rationale: RemovalRationale = {
      reviewItemId: clientItem.id,
      run: { path: 'src/http/client.ts', start: 6, end: 7 },
      reason: 'moved',
      description: 'Moved into the interceptor.',
      movedTo: { path: 'src/http/interceptor.ts', start: 81, end: 82 },
    };

    const strips = buildRemovalStrips(clientRows, clientItem.id, snapshot, {
      removals: [rationale],
    });

    expect(strips).toHaveLength(1);
    expect(strips[0]!.run).toEqual({
      start: 6,
      end: 7,
      lineIds: expect.any(Array),
      texts: ['moved line one', 'moved line two'],
    });
    expect(strips[0]!.rationale).toEqual(rationale);
    expect(strips[0]!.target).toEqual({
      kind: 'in-review',
      reviewItemId: interceptorItem.id,
      rowIds: expect.any(Array),
      path: 'src/http/interceptor.ts',
      start: 81,
      end: 82,
    });
  });

  it('leaves the target unresolved when no rationale covers the run', () => {
    const snapshot = buildFixtureSnapshot();
    const clientItem = snapshot.items[0]!;
    const clientContext = resolveReviewItemContext(snapshot, clientItem.id);
    const clientRows = clientContext.rows.filter(
      (row): row is ReviewDiffLineRow => row.kind !== 'scope',
    );

    const strips = buildRemovalStrips(clientRows, clientItem.id, snapshot, { removals: [] });

    expect(strips).toHaveLength(1);
    expect(strips[0]!.rationale).toBeUndefined();
    expect(strips[0]!.target).toEqual({ kind: 'unresolved' });
  });
});
