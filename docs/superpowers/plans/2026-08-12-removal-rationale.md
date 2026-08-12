# Removal Rationale Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every run of removed lines in a Synergy review carries a typed reason, a one-sentence explanation, and - when the logic moved - a navigable reference to where it went.

**Architecture:** `@synergy/review-core` derives the canonical removal runs from an immutable snapshot and resolves each authored `movedTo` reference into either an in-review jump target or a persisted excerpt. The CLI gates `review analysis-set` on complete coverage and resolves out-of-review excerpts once, at analysis time, so neither browser host needs git. The preview app and the VS Code webview render the same resolved model as a collapsed strip above each removal run.

**Tech Stack:** TypeScript (strict), pnpm workspaces, vitest, ajv (runtime schemas), React 18 (preview), plain DOM (VS Code webview), Shiki via `@synergy/review-core/highlight`.

## Global Constraints

- Spec of record: `docs/superpowers/specs/2026-08-12-removal-rationale-design.md`.
- `moved`, `merged`, `replaced` require `movedTo`. `dead-code`, `obsolete`, `extracted-to-dep` forbid it.
- A removal run authored in the payload must match a derived run exactly - no snapping, no fuzzy match.
- A `movedTo` that cannot be resolved is a rejection at `analysis-set`, never a soft warning.
- `MAX_DESCRIPTION_LENGTH` (600) from `packages/cli/src/review-analysis.ts` governs rationale descriptions.
- `MAX_MOVED_TO_LINES` = 40. A longer target span is rejected.
- Never hardcode palette hex values; use `--syn-*` tokens from `packages/preview/src/theme.css`.
- `packages/vscode-extension/media/panel.js` is a build artifact. Edit `src/webview/panel.js` only.
- `.claude-plugin/plugin.json` `version` must be bumped (release gate). Never hand-edit `marketplace.json` or `synergy-version` stamps - lefthook `version-sync` derives them.
- Scope reviews have no removals. Every derivation and gate is a no-op for `snapshot.kind === 'scope'`.
- Existing on-disk revisions have no `removals` field. It is optional everywhere; absence must never throw.

---

### Task 1: Removal types and persisted schema

**Files:**
- Modify: `packages/review-core/src/types.ts` (after `ReviewFileInsight`, ~line 200-213)
- Modify: `packages/review-core/src/schema.ts` (`reviewInsightsSchema`, ~line 300)
- Modify: `packages/review-core/src/index.ts` (type exports block at line 101)
- Test: `packages/review-core/tests/schema.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `RemovalReason`, `RemovalRunRef`, `RemovalTargetExcerpt`, `RemovalRationale`, and `ReviewInsights.removals?: RemovalRationale[]`.

- [ ] **Step 1: Write the failing test**

Append to `packages/review-core/tests/schema.test.ts`:

```ts
import { assertReviewInsights } from '../src/schema.js';

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
```

If `assertReviewInsights` is not the exported validator name in `schema.ts`, use whatever
`reviewInsightsSchema` is compiled into and asserted with in the existing tests in that file -
match the surrounding pattern exactly rather than inventing a second entry point.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @synergy/review-core test -- schema`
Expected: FAIL - the `moved` case throws because `removals` is not an allowed property.

- [ ] **Step 3: Add the types**

In `packages/review-core/src/types.ts`, directly after the `ReviewFileInsight` interface:

```ts
export type RemovalReason =
  | 'moved'
  | 'merged'
  | 'replaced'
  | 'dead-code'
  | 'obsolete'
  | 'extracted-to-dep';

/** Reasons that assert the logic still exists somewhere and therefore require a target. */
export const RELOCATING_REMOVAL_REASONS: readonly RemovalReason[] = ['moved', 'merged', 'replaced'];

export interface RemovalRunRef {
  path: string;
  start: number;
  end: number;
}

/** Exact destination text captured once at analysis time so browser hosts never need git. */
export interface RemovalTargetExcerpt {
  path: string;
  start: number;
  lines: string[];
}

export interface RemovalRationale {
  reviewItemId: string;
  /** Old-side line span of the removed run. */
  run: RemovalRunRef;
  reason: RemovalReason;
  description: string;
  /** New-side line span where the logic landed. Present only for relocating reasons. */
  movedTo?: RemovalRunRef;
  /** Present only when `movedTo` resolves outside the captured review. */
  movedToExcerpt?: RemovalTargetExcerpt;
}
```

Then add to `ReviewInsights`:

```ts
  removals?: RemovalRationale[];
```

- [ ] **Step 4: Add the runtime schema**

In `packages/review-core/src/schema.ts`, above `reviewInsightsSchema`:

```ts
const removalRunRefSchema = {
  type: 'object',
  required: ['path', 'start', 'end'],
  additionalProperties: false,
  properties: {
    path: nonEmptyString,
    start: { type: 'integer', minimum: 1 },
    end: { type: 'integer', minimum: 1 },
  },
} as const;

const removalRationaleSchema = {
  type: 'object',
  required: ['reviewItemId', 'run', 'reason', 'description'],
  additionalProperties: false,
  properties: {
    reviewItemId: nonEmptyString,
    run: removalRunRefSchema,
    reason: { enum: ['moved', 'merged', 'replaced', 'dead-code', 'obsolete', 'extracted-to-dep'] },
    description: nonEmptyString,
    movedTo: removalRunRefSchema,
    movedToExcerpt: {
      type: 'object',
      required: ['path', 'start', 'lines'],
      additionalProperties: false,
      properties: {
        path: nonEmptyString,
        start: { type: 'integer', minimum: 1 },
        lines: { type: 'array', items: string },
      },
    },
  },
} as const;
```

Add to `reviewInsightsSchema.properties`, next to `files`:

```ts
    removals: { type: 'array', items: removalRationaleSchema },
```

- [ ] **Step 5: Export the types**

In `packages/review-core/src/index.ts`, add to the `export type { … }` block at line 101:
`RemovalReason`, `RemovalRunRef`, `RemovalRationale`, `RemovalTargetExcerpt`. Add
`RELOCATING_REMOVAL_REASONS` to the value export block that already re-exports runtime constants.

- [ ] **Step 6: Run tests**

Run: `pnpm --filter @synergy/review-core test && pnpm --filter @synergy/review-core typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/review-core/src/types.ts packages/review-core/src/schema.ts packages/review-core/src/index.ts packages/review-core/tests/schema.test.ts
git commit -m "feat(review): add removal rationale types and persisted schema"
```

---

### Task 2: Derive removal runs and resolve targets

**Files:**
- Create: `packages/review-core/src/removals.ts`
- Create: `packages/review-core/tests/removals.test.ts`
- Modify: `packages/review-core/src/index.ts`
- Modify: `packages/review-core/src/browser.ts`

**Interfaces:**
- Consumes: Task 1 types; `resolveReviewItemContext` from `./review-lines.js`; `hashText` from `./hash.js`; `ReviewDiffLineRow`, `ReviewSnapshot` from `./types.js`.
- Produces:
  - `deriveRemovalRuns(rows: readonly ReviewDiffLineRow[]): RemovalRun[]`
  - `deriveSnapshotRemovalRuns(snapshot: ReviewSnapshot): SnapshotRemovalRun[]`
  - `removalRunHash(texts: readonly string[]): string`
  - `resolveRemovalTarget(snapshot: ReviewSnapshot, rationale: RemovalRationale): ResolvedRemovalTarget`
  - `buildRemovalStrips(rows, reviewItemId, snapshot, insights): RemovalStrip[]`

- [ ] **Step 1: Write the failing test**

Create `packages/review-core/tests/removals.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  buildRemovalStrips,
  deriveRemovalRuns,
  removalRunHash,
  resolveRemovalTarget,
} from '../src/removals.js';
import type { ReviewDiffLineRow } from '../src/types.js';

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
});
```

Add resolution tests using a diff snapshot fixture built the same way
`packages/review-core/tests/review-lines.test.ts` builds one - reuse that file's helper rather
than hand-writing a snapshot literal. Cover three cases:

```ts
describe('resolveRemovalTarget', () => {
  it('resolves a target that lands inside a captured item to an in-review jump', () => {
    // rationale.movedTo points at new-side lines covered by another hunk item
    const resolved = resolveRemovalTarget(snapshot, movedRationale);
    expect(resolved).toEqual({
      kind: 'in-review',
      reviewItemId: 'item-2',
      rowIds: ['<row ids of the covered new-side lines>'],
      path: 'src/http/interceptor.ts',
      start: 88,
      end: 89,
    });
  });

  it('resolves a target outside the review to its persisted excerpt', () => {
    const resolved = resolveRemovalTarget(snapshot, excerptRationale);
    expect(resolved).toEqual({
      kind: 'excerpt',
      path: 'src/other.ts',
      start: 12,
      lines: ['one', 'two'],
    });
  });

  it('reports an unresolved target when neither an item nor an excerpt matches', () => {
    expect(resolveRemovalTarget(snapshot, danglingRationale)).toEqual({ kind: 'unresolved' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @synergy/review-core test -- removals`
Expected: FAIL - `../src/removals.js` does not exist.

- [ ] **Step 3: Implement `removals.ts`**

```ts
import { hashText } from './hash.js';
import { resolveReviewItemContext } from './review-lines.js';
import type {
  RemovalRationale,
  ReviewDiffLineRow,
  ReviewInsights,
  ReviewSnapshot,
} from './types.js';

export interface RemovalRun {
  start: number;
  end: number;
  lineIds: string[];
  texts: string[];
}

export interface SnapshotRemovalRun extends RemovalRun {
  reviewItemId: string;
  path: string;
}

export type ResolvedRemovalTarget =
  | { kind: 'in-review'; reviewItemId: string; rowIds: string[]; path: string; start: number; end: number }
  | { kind: 'excerpt'; path: string; start: number; lines: string[] }
  | { kind: 'unresolved' };

export interface RemovalStrip {
  run: RemovalRun;
  rationale?: RemovalRationale;
  target: ResolvedRemovalTarget;
}

/** Groups maximal contiguous `remove` rows; old-side numbering, presentation order preserved. */
export function deriveRemovalRuns(rows: readonly ReviewDiffLineRow[]): RemovalRun[] {
  const runs: RemovalRun[] = [];
  let current: RemovalRun | undefined;
  for (const row of rows) {
    if (row.kind !== 'remove' || row.oldLine === null) {
      current = undefined;
      continue;
    }
    if (current && current.end + 1 === row.oldLine) {
      current.end = row.oldLine;
      current.lineIds.push(row.id);
      current.texts.push(row.text);
      continue;
    }
    current = { start: row.oldLine, end: row.oldLine, lineIds: [row.id], texts: [row.text] };
    runs.push(current);
  }
  return runs;
}

export function deriveSnapshotRemovalRuns(snapshot: ReviewSnapshot): SnapshotRemovalRun[] {
  if (snapshot.kind !== 'diff') return [];
  const runs: SnapshotRemovalRun[] = [];
  for (const item of snapshot.items) {
    if (item.kind !== 'hunk') continue;
    const context = resolveReviewItemContext(snapshot, item.id);
    const diffRows = context.rows.filter((row): row is ReviewDiffLineRow => row.kind !== 'scope');
    for (const run of deriveRemovalRuns(diffRows)) {
      runs.push({ ...run, reviewItemId: item.id, path: item.path });
    }
  }
  return runs;
}

/** Identity for carry-forward: ordered removed text only, so a pure offset shift still matches. */
export function removalRunHash(texts: readonly string[]): string {
  return hashText(texts.join('\n'));
}

export function resolveRemovalTarget(
  snapshot: ReviewSnapshot,
  rationale: RemovalRationale,
): ResolvedRemovalTarget {
  const target = rationale.movedTo;
  if (!target) return { kind: 'unresolved' };
  if (snapshot.kind === 'diff') {
    for (const item of snapshot.items) {
      if (item.kind !== 'hunk' || item.path !== target.path) continue;
      const context = resolveReviewItemContext(snapshot, item.id);
      const rowIds = context.rows
        .filter(
          (row): row is ReviewDiffLineRow =>
            row.kind !== 'scope' &&
            row.newLine !== null &&
            row.newLine >= target.start &&
            row.newLine <= target.end,
        )
        .map((row) => row.id);
      if (rowIds.length > 0) {
        return {
          kind: 'in-review',
          reviewItemId: item.id,
          rowIds,
          path: target.path,
          start: target.start,
          end: target.end,
        };
      }
    }
  }
  const excerpt = rationale.movedToExcerpt;
  if (excerpt) return { kind: 'excerpt', ...excerpt };
  return { kind: 'unresolved' };
}

/** One strip per derived run, in row order, with its rationale and resolved target attached. */
export function buildRemovalStrips(
  rows: readonly ReviewDiffLineRow[],
  reviewItemId: string,
  snapshot: ReviewSnapshot,
  insights: Pick<ReviewInsights, 'removals'>,
): RemovalStrip[] {
  const rationales = (insights.removals ?? []).filter(
    (rationale) => rationale.reviewItemId === reviewItemId,
  );
  return deriveRemovalRuns(rows).map((run) => {
    const rationale = rationales.find(
      (candidate) => candidate.run.start === run.start && candidate.run.end === run.end,
    );
    return {
      run,
      ...(rationale ? { rationale } : {}),
      target: rationale ? resolveRemovalTarget(snapshot, rationale) : { kind: 'unresolved' },
    };
  });
}
```

- [ ] **Step 4: Export from both entry points**

Add to `packages/review-core/src/index.ts`:

```ts
export {
  buildRemovalStrips,
  deriveRemovalRuns,
  deriveSnapshotRemovalRuns,
  removalRunHash,
  resolveRemovalTarget,
  type RemovalRun,
  type RemovalStrip,
  type ResolvedRemovalTarget,
  type SnapshotRemovalRun,
} from './removals.js';
```

Add `buildRemovalStrips` and `deriveRemovalRuns` to `packages/review-core/src/browser.ts` as
well - the preview and webview import from the browser entry point, which must stay free of
node-only imports. Verify `removals.ts` imports nothing node-specific (it imports only
`hash.js`, `review-lines.js`, and types).

- [ ] **Step 5: Run tests**

Run: `pnpm --filter @synergy/review-core test && pnpm --filter @synergy/review-core typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/review-core/src/removals.ts packages/review-core/src/index.ts packages/review-core/src/browser.ts packages/review-core/tests/removals.test.ts
git commit -m "feat(review): derive removal runs and resolve moved-to targets"
```

---

### Task 3: Coverage gate in the CLI

**Files:**
- Modify: `packages/cli/src/review-coverage.ts`
- Create: `packages/cli/src/review-removals.ts`
- Test: `packages/cli/src/review-removal-coverage.test.ts` (create)

**Interfaces:**
- Consumes: `deriveSnapshotRemovalRuns`, `RELOCATING_REMOVAL_REASONS`, `RemovalRationale` from `@synergy/review-core`.
- Produces: `assertCompleteRemovalCoverage(snapshot: ReviewSnapshot, removals: readonly RemovalRationale[]): void`, throwing with the same message style as `assertCompleteScopeCoverage`.

- [ ] **Step 1: Write the failing test**

Create `packages/cli/src/review-removal-coverage.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { assertCompleteRemovalCoverage } from './review-removals.js';

// Build `snapshot` with two removal runs: src/a.ts:41-43 and src/a.ts:50-50.
// Reuse the diff snapshot helper already used by review-actions.test.ts.

const covered = [
  {
    reviewItemId: 'item-1',
    run: { path: 'src/a.ts', start: 41, end: 43 },
    reason: 'dead-code' as const,
    description: 'Unreachable since v2.',
  },
  {
    reviewItemId: 'item-1',
    run: { path: 'src/a.ts', start: 50, end: 50 },
    reason: 'moved' as const,
    description: 'Moved to the interceptor.',
    movedTo: { path: 'src/b.ts', start: 88, end: 89 },
  },
];

describe('assertCompleteRemovalCoverage', () => {
  it('accepts a payload covering every derived run', () => {
    expect(() => assertCompleteRemovalCoverage(snapshot, covered)).not.toThrow();
  });

  it('lists every uncovered run', () => {
    expect(() => assertCompleteRemovalCoverage(snapshot, [covered[0]!])).toThrow(
      /src\/a\.ts:50-50/,
    );
  });

  it('rejects a run that does not match a derived run exactly', () => {
    const drifted = [{ ...covered[0]!, run: { path: 'src/a.ts', start: 41, end: 42 } }, covered[1]!];
    expect(() => assertCompleteRemovalCoverage(snapshot, drifted)).toThrow(
      /does not match a captured removal run/,
    );
  });

  it('rejects a relocating reason with no movedTo', () => {
    const missing = [covered[0]!, { ...covered[1]!, movedTo: undefined }];
    expect(() => assertCompleteRemovalCoverage(snapshot, missing)).toThrow(/requires movedTo/);
  });

  it('rejects a non-relocating reason that carries movedTo', () => {
    const extra = [
      { ...covered[0]!, movedTo: { path: 'src/b.ts', start: 1, end: 2 } },
      covered[1]!,
    ];
    expect(() => assertCompleteRemovalCoverage(snapshot, extra)).toThrow(/must not carry movedTo/);
  });

  it('rejects a duplicate rationale for one run', () => {
    expect(() => assertCompleteRemovalCoverage(snapshot, [...covered, covered[0]!])).toThrow(
      /duplicate removal rationale/,
    );
  });

  it('rejects a reversed or oversized movedTo span', () => {
    const reversed = [covered[0]!, { ...covered[1]!, movedTo: { path: 'src/b.ts', start: 9, end: 2 } }];
    expect(() => assertCompleteRemovalCoverage(snapshot, reversed)).toThrow(/reversed range/);
    const oversized = [covered[0]!, { ...covered[1]!, movedTo: { path: 'src/b.ts', start: 1, end: 99 } }];
    expect(() => assertCompleteRemovalCoverage(snapshot, oversized)).toThrow(/at most 40 lines/);
  });

  it('is a no-op for a scope snapshot', () => {
    expect(() => assertCompleteRemovalCoverage(scopeSnapshot, [])).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @synergy/cli test -- review-removal-coverage`
Expected: FAIL - `./review-removals.js` does not exist.

- [ ] **Step 3: Implement `review-removals.ts`**

```ts
import {
  RELOCATING_REMOVAL_REASONS,
  deriveSnapshotRemovalRuns,
  type RemovalRationale,
  type ReviewSnapshot,
} from '@synergy/review-core';

/** Kept in lockstep with `$defs.removalRationale` in review-analysis.schema.json. */
export const MAX_MOVED_TO_LINES = 40;

function runKey(path: string, start: number, end: number): string {
  return `${path}:${start}-${end}`;
}

export function assertCompleteRemovalCoverage(
  snapshot: ReviewSnapshot,
  removals: readonly RemovalRationale[],
): void {
  const derived = deriveSnapshotRemovalRuns(snapshot);
  if (derived.length === 0 && removals.length === 0) return;

  const derivedByKey = new Map(
    derived.map((run) => [runKey(run.path, run.start, run.end), run]),
  );
  const seen = new Set<string>();

  for (const rationale of removals) {
    const key = runKey(rationale.run.path, rationale.run.start, rationale.run.end);
    const run = derivedByKey.get(key);
    if (!run) {
      throw new Error(`removal rationale ${key} does not match a captured removal run`);
    }
    if (run.reviewItemId !== rationale.reviewItemId) {
      throw new Error(
        `removal rationale ${key} names review item ${rationale.reviewItemId} but the run belongs to ${run.reviewItemId}`,
      );
    }
    if (seen.has(key)) throw new Error(`duplicate removal rationale for ${key}`);
    seen.add(key);

    const relocating = RELOCATING_REMOVAL_REASONS.includes(rationale.reason);
    if (relocating && !rationale.movedTo) {
      throw new Error(`removal rationale ${key} with reason ${rationale.reason} requires movedTo`);
    }
    if (!relocating && rationale.movedTo) {
      throw new Error(
        `removal rationale ${key} with reason ${rationale.reason} must not carry movedTo`,
      );
    }
    const target = rationale.movedTo;
    if (target) {
      if (target.start > target.end) {
        throw new Error(`removal rationale ${key} has a reversed range in movedTo`);
      }
      if (target.end - target.start + 1 > MAX_MOVED_TO_LINES) {
        throw new Error(
          `removal rationale ${key} movedTo must span at most ${MAX_MOVED_TO_LINES} lines`,
        );
      }
    }
  }

  const missing = derived
    .filter((run) => !seen.has(runKey(run.path, run.start, run.end)))
    .map((run) => runKey(run.path, run.start, run.end));
  if (missing.length > 0) {
    throw new Error(`removal runs are missing a rationale: ${missing.join(', ')}`);
  }
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @synergy/cli test -- review-removal-coverage`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/review-removals.ts packages/cli/src/review-removal-coverage.test.ts
git commit -m "feat(review): gate analysis on complete removal coverage"
```

---

### Task 4: Accept removals in the analysis payload

**Files:**
- Modify: `packages/cli/src/review-analysis.ts` (`ReviewAnalysisInput` diff branch, parser)
- Modify: `packages/cli/src/review-analysis.schema.json`
- Modify: `packages/cli/src/review-actions.ts` (`assertValidAnalysis`, insights construction ~line 314 and the publish path)
- Test: `packages/cli/src/review-analysis.test.ts`, `packages/cli/src/review-actions.test.ts`

**Interfaces:**
- Consumes: Task 3's `assertCompleteRemovalCoverage`, `MAX_MOVED_TO_LINES`; Task 1's `RemovalRationale`.
- Produces: `removals?: RemovalRationale[]` on the diff branch of `ReviewAnalysisInput`, persisted onto `ReviewInsights.removals` by `setReviewAnalysis`.

- [ ] **Step 1: Write the failing test**

In `packages/cli/src/review-analysis.test.ts`, follow the existing agreement-test pattern and add:

```ts
it('parses removals on a diff analysis', () => {
  const parsed = parseReviewAnalysis({
    kind: 'diff',
    groups: [{ id: 'g1', label: 'G', reviewItemIds: ['item-1'] }],
    items: [{ reviewItemId: 'item-1', description: 'd', confidence: 'high', evidencePaths: ['a.ts'] }],
    removals: [
      {
        reviewItemId: 'item-1',
        run: { path: 'a.ts', start: 41, end: 43 },
        reason: 'dead-code',
        description: 'Unreachable.',
      },
    ],
  });
  expect(parsed.removals).toHaveLength(1);
});

it('rejects an unknown key inside a removal', () => {
  expect(() =>
    parseReviewAnalysis({
      kind: 'diff',
      groups: [{ id: 'g1', label: 'G', reviewItemIds: ['item-1'] }],
      items: [{ reviewItemId: 'item-1', description: 'd', confidence: 'high', evidencePaths: ['a.ts'] }],
      removals: [{ reviewItemId: 'item-1', run: { path: 'a.ts', start: 41, end: 43 }, reason: 'dead-code', description: 'd', nope: 1 }],
    }),
  ).toThrow(/nope/);
});

it('keeps the removal schema in lockstep with the parser constants', () => {
  const schema = JSON.parse(
    readFileSync(new URL('./review-analysis.schema.json', import.meta.url), 'utf8'),
  );
  expect(schema.$defs.removalRationale.properties.description.maxLength).toBe(
    MAX_DESCRIPTION_LENGTH,
  );
  expect(schema.$defs.removalRationale.properties.reason.enum).toEqual([
    'moved',
    'merged',
    'replaced',
    'dead-code',
    'obsolete',
    'extracted-to-dep',
  ]);
  expect(schema.$defs.removalRationale.required).toEqual([
    'reviewItemId',
    'run',
    'reason',
    'description',
  ]);
});
```

Use whichever parse entry point the file already tests (`parseReviewAnalysis` or equivalent);
match the existing import list rather than adding a new one.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @synergy/cli test -- review-analysis`
Expected: FAIL - `removals` is rejected as an unexpected key.

- [ ] **Step 3: Extend the parser**

In `packages/cli/src/review-analysis.ts`, add `removals?: RemovalRationale[]` to the `kind: 'diff'`
branch of `ReviewAnalysisInput`, add `'removals'` to the diff branch's `assertOnlyKeys` list, and
add a parse function beside the existing insight parsers:

```ts
const REMOVAL_REASONS = new Set<RemovalReason>([
  'moved',
  'merged',
  'replaced',
  'dead-code',
  'obsolete',
  'extracted-to-dep',
]);

function parseRemovalRunRef(value: unknown, path: string): RemovalRunRef {
  assertRecord(value, path);
  assertOnlyKeys(value, ['path', 'start', 'end'], path);
  assertString(value.path, `${path}.path`);
  assertPositiveInteger(value.start, `${path}.start`);
  assertPositiveInteger(value.end, `${path}.end`);
  return { path: value.path, start: value.start, end: value.end };
}

function parseRemovalRationale(value: unknown, path: string): RemovalRationale {
  assertRecord(value, path);
  assertOnlyKeys(
    value,
    ['reviewItemId', 'run', 'reason', 'description', 'movedTo'],
    path,
  );
  assertString(value.reviewItemId, `${path}.reviewItemId`);
  assertDescription(value.description, `${path}.description`);
  if (typeof value.reason !== 'string' || !REMOVAL_REASONS.has(value.reason as RemovalReason)) {
    fail(`${path}.reason`, 'must be a known removal reason');
  }
  return {
    reviewItemId: value.reviewItemId,
    run: parseRemovalRunRef(value.run, `${path}.run`),
    reason: value.reason as RemovalReason,
    description: value.description,
    ...(value.movedTo === undefined
      ? {}
      : { movedTo: parseRemovalRunRef(value.movedTo, `${path}.movedTo`) }),
  };
}
```

`movedToExcerpt` is deliberately **not** accepted from the agent - the CLI derives it. Reuse the
file's existing `assertPositiveInteger` helper; if none exists, add one next to `assertString`
that fails unless the value is an integer `>= 1`.

- [ ] **Step 4: Extend the JSON schema**

In `packages/cli/src/review-analysis.schema.json`, add to `$defs.diffAnalysis.properties`:

```json
        "removals": {
          "type": "array",
          "minItems": 1,
          "items": { "$ref": "#/$defs/removalRationale" }
        }
```

and add the definition:

```json
    "removalRunRef": {
      "type": "object",
      "additionalProperties": false,
      "required": ["path", "start", "end"],
      "properties": {
        "path": { "type": "string", "minLength": 1, "pattern": "\\S" },
        "start": { "type": "integer", "minimum": 1 },
        "end": { "type": "integer", "minimum": 1 }
      }
    },
    "removalRationale": {
      "type": "object",
      "additionalProperties": false,
      "required": ["reviewItemId", "run", "reason", "description"],
      "properties": {
        "reviewItemId": { "type": "string", "minLength": 1, "pattern": "\\S" },
        "run": { "$ref": "#/$defs/removalRunRef" },
        "reason": {
          "enum": ["moved", "merged", "replaced", "dead-code", "obsolete", "extracted-to-dep"]
        },
        "description": { "type": "string", "minLength": 1, "maxLength": 600, "pattern": "\\S" },
        "movedTo": { "$ref": "#/$defs/removalRunRef" }
      }
    }
```

- [ ] **Step 5: Wire the gate and persistence**

In `packages/cli/src/review-actions.ts`:

1. Import `assertCompleteRemovalCoverage` from `./review-removals.js`.
2. At the end of `assertValidAnalysis`, for diff snapshots only:
   `assertCompleteRemovalCoverage(snapshot, analysis.removals ?? []);`
3. Where the finalized `ReviewInsights` document is assembled in the publish path, carry the
   removals through: `...(analysis.removals ? { removals: analysis.removals } : {})`.
4. Leave the empty `insights` literal at line ~314 (revision creation) untouched except for the
   carry-forward addition in Task 6.

- [ ] **Step 6: Run tests**

Run: `pnpm --filter @synergy/cli test && pnpm --filter @synergy/cli typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/review-analysis.ts packages/cli/src/review-analysis.schema.json packages/cli/src/review-actions.ts packages/cli/src/review-analysis.test.ts packages/cli/src/review-actions.test.ts
git commit -m "feat(review): accept and persist removal rationales in analysis-set"
```

---

### Task 5: Resolve out-of-review excerpts at analysis time

**Files:**
- Modify: `packages/cli/src/review-removals.ts`
- Modify: `packages/cli/src/review-actions.ts`
- Test: `packages/cli/src/review-removal-coverage.test.ts`

**Interfaces:**
- Consumes: `resolveRemovalTarget` from `@synergy/review-core`; the `runner` and `readFile`
  dependencies already threaded through `review-actions.ts` requests.
- Produces: `resolveRemovalExcerpts(snapshot, removals, io): RemovalRationale[]` returning
  rationales with `movedToExcerpt` populated for out-of-review targets.

- [ ] **Step 1: Write the failing test**

```ts
describe('resolveRemovalExcerpts', () => {
  const io = {
    readTargetLines: (path: string) =>
      path === 'src/b.ts' ? ['line88', 'line89'] : undefined,
  };

  it('attaches an excerpt for a target outside the review', () => {
    const [resolved] = resolveRemovalExcerpts(snapshot, [movedOutsideRationale], io);
    expect(resolved?.movedToExcerpt).toEqual({ path: 'src/b.ts', start: 88, lines: ['line88', 'line89'] });
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @synergy/cli test -- review-removal-coverage`
Expected: FAIL - `resolveRemovalExcerpts` is not exported.

- [ ] **Step 3: Implement excerpt resolution**

Append to `packages/cli/src/review-removals.ts`:

```ts
export interface RemovalExcerptIo {
  /** Returns the target file's lines, or undefined when the path does not exist at the source. */
  readTargetLines(path: string): string[] | undefined;
}

export function resolveRemovalExcerpts(
  snapshot: ReviewSnapshot,
  removals: readonly RemovalRationale[],
  io: RemovalExcerptIo,
): RemovalRationale[] {
  return removals.map((rationale) => {
    const target = rationale.movedTo;
    if (!target) return rationale;
    if (resolveRemovalTarget(snapshot, rationale).kind === 'in-review') return rationale;

    const lines = io.readTargetLines(target.path);
    if (!lines) {
      throw new Error(`removal rationale movedTo target was not found: ${target.path}`);
    }
    if (target.end > lines.length) {
      throw new Error(
        `removal rationale movedTo ${target.path}:${target.start}-${target.end} is out of range (file has ${lines.length} lines)`,
      );
    }
    return {
      ...rationale,
      movedToExcerpt: {
        path: target.path,
        start: target.start,
        lines: lines.slice(target.start - 1, target.end),
      },
    };
  });
}
```

- [ ] **Step 4: Wire it into the publish path**

In `packages/cli/src/review-actions.ts`, build the `RemovalExcerptIo` from the snapshot's source
kind, mirroring how `skills/review/SKILL.md` says each kind must be inspected:

```ts
function removalExcerptIo(
  root: string,
  source: ReviewSource,
  runner: CommandRunner,
  readFile: ReadFile,
): RemovalExcerptIo {
  return {
    readTargetLines(path) {
      const spec =
        source.kind === 'pr'
          ? `${source.headSha}:${path}`
          : source.kind === 'staged'
            ? `:${path}`
            : undefined;
      const text =
        spec === undefined
          ? readFile(join(root, path))
          : runOptional(runner, root, ['show', spec]);
      return text === undefined ? undefined : text.split('\n');
    },
  };
}
```

`runOptional` runs `git -C <root> show <spec>` and returns `undefined` on a non-zero exit rather
than throwing - add it next to the existing git helpers in this file, reusing the same
`CommandRunner`/`ReadFile` types the module already imports. `readFile` must return `undefined`
for a missing path rather than throwing.

Call `resolveRemovalExcerpts` after `assertValidAnalysis` and persist its return value, so the
stored `removals` always carry their excerpts.

- [ ] **Step 5: Run tests**

Run: `pnpm --filter @synergy/cli test && pnpm --filter @synergy/cli typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/review-removals.ts packages/cli/src/review-actions.ts packages/cli/src/review-removal-coverage.test.ts
git commit -m "feat(review): capture moved-to excerpts at analysis time"
```

---

### Task 6: Removals in status output and carry-forward on refresh

**Files:**
- Modify: `packages/cli/src/review-actions.ts` (status/create result shape, ~line 51 and ~line 249)
- Modify: `packages/review-core/src/reconcile.ts`
- Test: `packages/cli/src/review-actions.test.ts`, `packages/review-core/tests/reconcile.test.ts`

**Interfaces:**
- Consumes: `deriveSnapshotRemovalRuns`, `removalRunHash` from `@synergy/review-core`.
- Produces: `removals: { reviewItemId, path, start, end, covered }[]` on create/status results;
  `ReviewReconciliation.insights.removals?: RemovalRationale[]`.

- [ ] **Step 1: Write the failing tests**

In `packages/cli/src/review-actions.test.ts`:

```ts
it('reports every derived removal run and its coverage in status', () => {
  const status = getReviewStatus({ root, reference });
  expect(status.removals).toEqual([
    { reviewItemId: 'item-1', path: 'src/a.ts', start: 41, end: 43, covered: false },
  ]);
});

it('marks runs covered once analysis is finalized', () => {
  setReviewAnalysis({ root, reference, analysis: analysisWithRemovals });
  expect(getReviewStatus({ root, reference }).removals[0]?.covered).toBe(true);
});
```

In `packages/review-core/tests/reconcile.test.ts`:

```ts
it('carries a removal rationale when its item and run text are unchanged', () => {
  const result = reconcileReview(previousBundle, nextSnapshot, now);
  expect(result.insights.removals).toEqual([previousRationale]);
});

it('drops a removal rationale when the removed text changed', () => {
  const result = reconcileReview(previousBundleWithEditedRun, nextSnapshot, now);
  expect(result.insights.removals ?? []).toEqual([]);
});

it('drops a removal rationale whose review item did not carry forward', () => {
  const result = reconcileReview(previousBundle, snapshotWithoutThatItem, now);
  expect(result.insights.removals ?? []).toEqual([]);
});
```

Use the reconcile test file's existing bundle/snapshot builders; do not hand-roll new fixtures.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @synergy/cli test -- review-actions && pnpm --filter @synergy/review-core test -- reconcile`
Expected: FAIL - `status.removals` is undefined; `result.insights.removals` is undefined.

- [ ] **Step 3: Add the status payload**

In `packages/cli/src/review-actions.ts`, add to the status/create result interface:

```ts
  removals: { reviewItemId: string; path: string; start: number; end: number; covered: boolean }[];
```

and populate it where `analysisRequired` is computed (~line 249):

```ts
  const coveredRunKeys = new Set(
    (bundle.insights.removals ?? []).map(
      (rationale) => `${rationale.run.path}:${rationale.run.start}-${rationale.run.end}`,
    ),
  );
  const removals = deriveSnapshotRemovalRuns(bundle.snapshot).map((run) => ({
    reviewItemId: run.reviewItemId,
    path: run.path,
    start: run.start,
    end: run.end,
    covered: coveredRunKeys.has(`${run.path}:${run.start}-${run.end}`),
  }));
```

The `--json` output already serializes the whole result object, so no CLI formatting change is
needed beyond including `removals` in any human-readable status printer that enumerates fields.
If `review status` prints a human summary, add one line: `removals: <covered>/<total> explained`.

- [ ] **Step 4: Add carry-forward**

In `packages/review-core/src/reconcile.ts`, extend the reconciliation result type to
`insights: { files?: ReviewFileInsight[]; removals?: RemovalRationale[] }` and add, mirroring
`carryForwardFileInsights`:

```ts
/**
 * Carries a rationale into the next revision only when its review item carried forward and the
 * run's removed text is byte-identical, so a stale explanation can never outlive its code.
 */
function carryForwardRemovals(
  previousInsights: ReviewInsights,
  previousSnapshot: ReviewSnapshot,
  currentSnapshot: ReviewSnapshot,
  /** Current item id -> the previous item id it inherited from. */
  inheritance: ReadonlyMap<string, string>,
): RemovalRationale[] | undefined {
  const previousRemovals = previousInsights.removals ?? [];
  if (previousRemovals.length === 0) return undefined;

  const byItem = (runs: SnapshotRemovalRun[]): Map<string, SnapshotRemovalRun[]> => {
    const index = new Map<string, SnapshotRemovalRun[]>();
    for (const run of runs) {
      const list = index.get(run.reviewItemId) ?? [];
      list.push(run);
      index.set(run.reviewItemId, list);
    }
    return index;
  };
  const previousRuns = byItem(deriveSnapshotRemovalRuns(previousSnapshot));
  const currentRuns = byItem(deriveSnapshotRemovalRuns(currentSnapshot));

  const carried: RemovalRationale[] = [];
  for (const [currentItemId, previousItemId] of inheritance) {
    const before = previousRuns.get(previousItemId) ?? [];
    const after = currentRuns.get(currentItemId) ?? [];
    if (before.length !== after.length) continue;
    for (const [ordinal, beforeRun] of before.entries()) {
      const afterRun = after[ordinal]!;
      if (removalRunHash(beforeRun.texts) !== removalRunHash(afterRun.texts)) continue;
      const rationale = previousRemovals.find(
        (candidate) =>
          candidate.reviewItemId === previousItemId &&
          candidate.run.start === beforeRun.start &&
          candidate.run.end === beforeRun.end,
      );
      if (!rationale) continue;
      carried.push({
        ...rationale,
        reviewItemId: currentItemId,
        run: { path: afterRun.path, start: afterRun.start, end: afterRun.end },
      });
    }
  }
  return carried.length > 0 ? carried : undefined;
}
```

Two subtleties this encodes, both load-bearing:

- **Item ids are not stable across revisions.** `reconcileReview` records the mapping in
  `inheritedFrom.reviewItemId`, so build `inheritance` from the reconciled `items` record -
  `new Map(Object.entries(items).filter(([, p]) => p.inheritedFrom).map(([id, p]) => [id, p.inheritedFrom!.reviewItemId]))` -
  and rewrite each carried rationale's `reviewItemId` to the new id.
- **Line numbers shift even when nothing changed**, which is exactly why `reconciliationKey`
  ignores offsets. So runs match by ordinal within the item plus text hash, and the carried
  rationale's `run` is rewritten to the new revision's line numbers. Matching on the old
  `start`/`end` would drop every rationale after a one-line edit earlier in the file.

Return `removals` alongside `files` from `reconcileReview`, and in `review-actions.ts` seed the
new revision's empty insights literal with
`...(reconciliation?.removals ? { removals: reconciliation.removals } : {})`.

- [ ] **Step 5: Run tests**

Run: `pnpm --filter @synergy/review-core test && pnpm --filter @synergy/cli test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/review-actions.ts packages/cli/src/review-actions.test.ts packages/review-core/src/reconcile.ts packages/review-core/tests/reconcile.test.ts
git commit -m "feat(review): report removal coverage and carry rationales across revisions"
```

---

### Task 7: The removal strip in the preview

**Files:**
- Create: `packages/preview/src/review/RemovalStrip.tsx`
- Create: `packages/preview/src/review/RemovalStrip.test.tsx`
- Modify: `packages/preview/src/review/DiffViewer.tsx`
- Modify: `packages/preview/src/review/ReviewStage.tsx` (DiffViewer call at line 129)
- Modify: `packages/preview/src/review/review.css`

**Interfaces:**
- Consumes: `buildRemovalStrips`, `RemovalStrip` (type) from `@synergy/review-core/browser`.
- Produces: `<RemovalStrip strip={…} expanded={…} onToggle={…} onJump={…} />`; `DiffViewer` gains
  props `strips: RemovalStripModel[]`, `expandedRuns: string[]`, `onToggleRun(key: string): void`,
  `onJump(target: ResolvedRemovalTarget): void`.

- [ ] **Step 1: Write the failing test**

Create `packages/preview/src/review/RemovalStrip.test.tsx` following the render/assert style of
the existing preview tests:

```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RemovalStrip } from './RemovalStrip.js';

const strip = {
  run: { start: 41, end: 43, lineIds: ['r1', 'r2', 'r3'], texts: ['a', 'b', 'c'] },
  rationale: {
    reviewItemId: 'item-1',
    run: { path: 'a.ts', start: 41, end: 43 },
    reason: 'moved' as const,
    description: 'Refresh converged into the interceptor.',
    movedTo: { path: 'b.ts', start: 88, end: 89 },
  },
  target: {
    kind: 'in-review' as const,
    reviewItemId: 'item-2',
    rowIds: ['r9'],
    path: 'b.ts',
    start: 88,
    end: 89,
  },
};

describe('RemovalStrip', () => {
  it('shows the category and line count while collapsed', () => {
    render(<RemovalStrip strip={strip} expanded={false} onToggle={() => {}} onJump={() => {}} />);
    expect(screen.getByText('moved')).toBeTruthy();
    expect(screen.getByText(/3 lines removed/)).toBeTruthy();
    expect(screen.queryByText(/converged into the interceptor/)).toBeNull();
  });

  it('shows the sentence when expanded', () => {
    render(<RemovalStrip strip={strip} expanded onToggle={() => {}} onJump={() => {}} />);
    expect(screen.getByText(/converged into the interceptor/)).toBeTruthy();
  });

  it('calls onJump with the resolved target', () => {
    const onJump = vi.fn();
    render(<RemovalStrip strip={strip} expanded onToggle={() => {}} onJump={onJump} />);
    screen.getByRole('button', { name: /b\.ts:88/ }).click();
    expect(onJump).toHaveBeenCalledWith(strip.target);
  });

  it('renders the excerpt instead of a jump for an out-of-review target', () => {
    const excerptStrip = {
      ...strip,
      target: { kind: 'excerpt' as const, path: 'b.ts', start: 88, lines: ['if (x) {', '}'] },
    };
    render(<RemovalStrip strip={excerptStrip} expanded onToggle={() => {}} onJump={() => {}} />);
    expect(screen.queryByRole('button', { name: /b\.ts:88/ })).toBeNull();
    expect(screen.getByText('if (x) {')).toBeTruthy();
  });

  it('renders nothing when a run has no rationale', () => {
    const { container } = render(
      <RemovalStrip
        strip={{ run: strip.run, target: { kind: 'unresolved' } }}
        expanded={false}
        onToggle={() => {}}
        onJump={() => {}}
      />,
    );
    expect(container.firstChild).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @synergy/preview test -- RemovalStrip`
Expected: FAIL - `./RemovalStrip.js` does not exist.

- [ ] **Step 3: Implement the component**

```tsx
import type { RemovalStrip as RemovalStripModel, ResolvedRemovalTarget } from '@synergy/review-core/browser';

interface RemovalStripProps {
  strip: RemovalStripModel;
  expanded: boolean;
  onToggle(): void;
  onJump(target: ResolvedRemovalTarget): void;
}

const REASON_LABEL: Record<string, string> = {
  moved: 'moved',
  merged: 'merged',
  replaced: 'replaced',
  'dead-code': 'dead-code',
  obsolete: 'obsolete',
  'extracted-to-dep': 'extracted to dep',
};

/** One collapsed row per removal run: category, size, and destination stay visible while scanning. */
export function RemovalStrip({ strip, expanded, onToggle, onJump }: RemovalStripProps) {
  const { rationale, run, target } = strip;
  if (!rationale) return null;
  const count = run.end - run.start + 1;
  return (
    <div className="review-removal">
      <button
        type="button"
        className="review-removal__strip"
        aria-expanded={expanded}
        onClick={onToggle}
      >
        <span className="review-removal__caret" aria-hidden="true">
          {expanded ? '▾' : '▸'}
        </span>
        <span className={`review-removal__cat review-removal__cat--${rationale.reason}`}>
          {REASON_LABEL[rationale.reason] ?? rationale.reason}
        </span>
        <span className="review-removal__count">
          {count} {count === 1 ? 'line' : 'lines'} removed
        </span>
      </button>
      {target.kind === 'in-review' ? (
        <button
          type="button"
          className="review-removal__jump"
          onClick={() => onJump(target)}
        >
          {`→ ${target.path}:${target.start}`}
        </button>
      ) : null}
      {expanded ? (
        <div className="review-removal__detail">
          <p>{rationale.description}</p>
          {target.kind === 'excerpt' ? (
            <div className="review-removal__peek">
              <div className="review-removal__peek-head">{`${target.path} · lines ${target.start}-${target.start + target.lines.length - 1}`}</div>
              <pre>{target.lines.join('\n')}</pre>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
```

A button rather than `<details>`, because the strip must sit inside the diff grid and control an
adjacent detail block; `aria-expanded` carries the same semantics.

- [ ] **Step 4: Render strips inside the diff**

In `DiffViewer.tsx`, accept the new props and, while mapping rows, emit a `<RemovalStrip>` before
the row whose `id` equals `strip.run.lineIds[0]`:

```tsx
const stripByFirstLineId = new Map(strips.map((strip) => [strip.run.lineIds[0]!, strip]));
// inside the row map, before the row element:
const strip = stripByFirstLineId.get(row.id);
// render: {strip ? <RemovalStrip … key={`strip-${row.id}`} /> : null}
```

Use `runKey = `${strip.run.start}-${strip.run.end}`` as the expansion key. In `ReviewStage.tsx`,
build the strips with `buildRemovalStrips(diffRows, item.id, bundle.snapshot, bundle.insights)` and
hold `expandedRuns` in `useState`, seeded from
`localStorage.getItem(`synergy.review.removals.${bundle.snapshot.revisionId}`)` and written back on
change. Wrap both localStorage calls in try/catch - a private-mode failure must not break the pane.

- [ ] **Step 5: Style it**

Append to `packages/preview/src/review/review.css`, tokens only:

```css
.review-removal {
  display: grid;
  gap: var(--syn-sp-1);
  padding: 2px var(--syn-sp-3);
  background: linear-gradient(to right, var(--syn-diff-del-bg), transparent 60%);
  border-top: 1px solid var(--syn-border);
  font-family: var(--syn-font-ui);
  font-size: var(--syn-text-sm);
  color: var(--syn-fg-muted);
}

.review-removal__strip {
  display: flex;
  align-items: center;
  gap: var(--syn-sp-2);
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
  text-align: left;
}

.review-removal__cat {
  border-radius: var(--syn-radius-full);
  border: 1px solid var(--syn-border-strong);
  padding: 1px 8px;
  font-size: var(--syn-text-xs);
  letter-spacing: var(--syn-tracking-wide);
  text-transform: uppercase;
}

.review-removal__cat--moved,
.review-removal__cat--merged {
  color: var(--syn-status-shipped);
  border-color: var(--syn-status-shipped);
}

.review-removal__cat--replaced {
  color: var(--syn-warn);
  border-color: var(--syn-warn);
}

.review-removal__jump {
  justify-self: start;
  border: 0;
  border-bottom: 1px dashed var(--syn-accent-border);
  background: transparent;
  padding: 0;
  color: var(--syn-accent-fg);
  font-family: var(--syn-font-mono);
  font-size: var(--syn-text-sm);
  cursor: pointer;
}

.review-removal__peek {
  border: 1px solid var(--syn-border-strong);
  border-radius: var(--syn-radius-sm);
  background: var(--syn-bg-sunken);
  overflow-x: auto;
  font-family: var(--syn-font-mono);
  font-size: var(--syn-text-sm);
}

.review-removal__peek pre {
  margin: 0;
  padding: var(--syn-sp-2);
}
```

- [ ] **Step 6: Run tests**

Run: `pnpm --filter @synergy/preview test && pnpm --filter @synergy/preview typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/preview/src/review/RemovalStrip.tsx packages/preview/src/review/RemovalStrip.test.tsx packages/preview/src/review/DiffViewer.tsx packages/preview/src/review/ReviewStage.tsx packages/preview/src/review/review.css
git commit -m "feat(review): render removal rationale strips in the preview diff"
```

---

### Task 8: Jump navigation and expand-all

**Files:**
- Modify: `packages/preview/src/review/ReviewStage.tsx`
- Modify: `packages/preview/src/review/ReviewProvider.tsx`
- Modify: `packages/preview/src/review/types.ts`
- Modify: `packages/preview/src/review/ReviewHeader.tsx` (toolbar)
- Modify: `packages/preview/src/review/review.css`
- Test: `packages/preview/src/review/ReviewStage.test.tsx` (create if absent)

**Interfaces:**
- Consumes: `advanceTo` from the walkthrough context (`ReviewProvider.tsx:106`).
- Produces: context additions `jumpTo(target: ResolvedRemovalTarget & { kind: 'in-review' }, origin: { reviewItemId: string; label: string }): void`, `jumpOrigin?: { reviewItemId: string; label: string }`, `clearJumpOrigin(): void`, and `flashedRowIds: string[]`.

- [ ] **Step 1: Write the failing test**

```tsx
it('jumping sets the active item, flashes the target rows, and offers a way back', async () => {
  renderReviewAt('item-1');
  screen.getByRole('button', { name: /→ src\/http\/interceptor\.ts:88/ }).click();
  expect(setActiveItem).toHaveBeenCalledWith('item-2');
  expect(document.querySelector('.review-code-row.is-flashed')).toBeTruthy();
  expect(screen.getByRole('button', { name: /back to src\/auth\/session\.ts:41/ })).toBeTruthy();
});

it('jumping does not change any review status', () => {
  renderReviewAt('item-1');
  screen.getByRole('button', { name: /→ src\/http\/interceptor\.ts:88/ }).click();
  expect(setItemStatus).not.toHaveBeenCalled();
});

it('expand all opens every strip and collapse all closes them', () => {
  renderReviewAt('item-1');
  screen.getByRole('button', { name: /expand all/i }).click();
  expect(screen.getAllByText(/converged into the interceptor/).length).toBeGreaterThan(0);
  screen.getByRole('button', { name: /collapse all/i }).click();
  expect(screen.queryByText(/converged into the interceptor/)).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @synergy/preview test -- ReviewStage`
Expected: FAIL - no jump handler is wired.

- [ ] **Step 3: Implement jump**

In `ReviewProvider.tsx`, add a `jumpOrigin` state and a `jumpTo` callback that calls the existing
`advanceTo(target.reviewItemId)`, records `{ reviewItemId, label }` for the origin, and stores
`target.rowIds` as `flashedRowIds`. Clear `flashedRowIds` after 1200ms with a `setTimeout` cleaned
up on unmount. `jumpTo` must not call `setItemStatus` or any progress mutation.

In `ReviewStage.tsx`, pass `flashedRowIds` down to `DiffViewer`, which adds `is-flashed` to the
matching rows, and render the back chip when `jumpOrigin` is set:

```tsx
{jumpOrigin ? (
  <button type="button" className="review-jump-back" onClick={() => { advanceTo(jumpOrigin.reviewItemId); clearJumpOrigin(); }}>
    {`← back to ${jumpOrigin.label}`}
  </button>
) : null}
```

CSS, tokens only:

```css
.review-code-row.is-flashed {
  background: var(--syn-accent-soft-strong);
  box-shadow: inset 3px 0 var(--syn-accent);
  transition: background var(--syn-dur-slow) var(--syn-ease-out);
}

.review-jump-back {
  align-self: start;
  border: 1px solid var(--syn-accent-border);
  border-radius: var(--syn-radius-full);
  background: var(--syn-accent-soft);
  color: var(--syn-accent-fg);
  padding: 2px 10px;
  font-size: var(--syn-text-sm);
  cursor: pointer;
}
```

- [ ] **Step 4: Implement expand-all**

Add an `Expand all` / `Collapse all` toggle to the review toolbar in `ReviewHeader.tsx`, rendered
only when the active item has at least one strip. It sets `expandedRuns` to every run key or to
`[]`, and persists through the same localStorage key used in Task 7.

- [ ] **Step 5: Run tests**

Run: `pnpm --filter @synergy/preview test && pnpm --filter @synergy/preview typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/preview/src/review
git commit -m "feat(review): jump to moved-to targets and toggle every removal strip"
```

---

### Task 9: VS Code webview parity

**Files:**
- Modify: `packages/vscode-extension/src/webview/panel.js` (`renderDiffLines`, line 254)
- Modify: `packages/vscode-extension/src/webview/panel.css` (or the stylesheet `panel.js` ships with)
- Test: `packages/vscode-extension/src/test/` - add to the existing webview unit test file

**Interfaces:**
- Consumes: `buildRemovalStrips` from `@synergy/review-core/browser` (already bundled by `esbuild.mjs`).
- Produces: no new exports; DOM parity with the preview's strip.

- [ ] **Step 1: Write the failing test**

```js
it('renders one removal strip per run above the first removed line', () => {
  const html = renderDiffLines(hunkWithTwoRemovalRuns, 'src/a.ts');
  expect(html.match(/removal-strip/g)?.length).toBe(2);
  expect(html).toContain('moved');
  expect(html).toContain('3 lines removed');
});

it('renders an open-in-editor action for an out-of-review target', () => {
  const html = renderDiffLines(hunkWithExcerptTarget, 'src/a.ts');
  expect(html).toContain('data-open-path="src/b.ts"');
  expect(html).toContain('data-open-line="88"');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter synergy-review test`
Expected: FAIL - no strip markup is emitted.

- [ ] **Step 3: Implement**

In `src/webview/panel.js`, compute `buildRemovalStrips(rows, item.id, snapshot, insights)` where
`renderDiffLines` is called, and emit the same three-part markup as the preview (`removal-strip`,
`removal-cat`, `removal-detail`) using the webview's existing escaping helper. Wire the
collapse toggle to a class swap, and post
`{ type: 'openFile', path, line }` to the extension host for out-of-review targets, handled next
to the existing message handlers. Mirror the preview's class names with the webview's prefix
convention already used in this file.

- [ ] **Step 4: Rebuild the bundle**

Run: `pnpm --filter synergy-review build`
This regenerates `media/panel.js`. Never edit that file by hand.

- [ ] **Step 5: Run tests**

Run: `pnpm --filter synergy-review test && pnpm --filter synergy-review typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/vscode-extension/src packages/vscode-extension/media
git commit -m "feat(review): show removal rationale in the VS Code review panel"
```

---

### Task 10: Skill contract, docs, and release

**Files:**
- Modify: `skills/review/SKILL.md`
- Modify: `CLAUDE.md` (guided code review section)
- Modify: `.claude-plugin/plugin.json`
- Test: full workspace suite

**Interfaces:**
- Consumes: everything above.
- Produces: the authoring contract agents follow.

- [ ] **Step 1: Document the authoring step in the skill**

In `skills/review/SKILL.md`, in the analysis section, add:

> ### Removal rationale
>
> `review create --json` and `review status --json` list every captured removal run as
> `removals: [{reviewItemId, path, start, end, covered}]`. The analysis payload must carry one
> entry per run under `removals`, matching `path`, `start`, and `end` exactly:
>
> ```json
> {
>   "reviewItemId": "<captured id>",
>   "run": { "path": "src/auth/session.ts", "start": 41, "end": 43 },
>   "reason": "moved",
>   "description": "One sentence explaining why these lines are gone.",
>   "movedTo": { "path": "src/http/interceptor.ts", "start": 88, "end": 91 }
> }
> ```
>
> Use `moved`, `merged`, or `replaced` only after inspecting the destination at the captured
> source (`git show <headSha>:<path>` for a PR, `git show :<path>` for staged, the worktree file
> for unstaged and scope) and confirming the logic is actually there. If you cannot confirm it,
> use `dead-code`, `obsolete`, or `extracted-to-dep`, which take no `movedTo`. `analysis-set`
> rejects the whole payload when a run is uncovered, when a claimed target does not resolve, or
> when the reason and `movedTo` disagree. `movedTo` may span at most 40 lines. Scope reviews have
> no removal runs.

- [ ] **Step 2: Update CLAUDE.md**

Add one bullet under "Guided code review (v4)":

> - **Removal rationale.** Every contiguous run of removed lines carries a typed reason and one
>   sentence, gated at `review analysis-set`. Relocating reasons carry a `movedTo` reference that
>   resolves to an in-review jump or, when the destination is outside the capture, to an excerpt
>   captured once at analysis time. Derivation and resolution live in
>   `@synergy/review-core/removals`; add categories there, never per host.

- [ ] **Step 3: Bump the version**

Edit only the `version` field in `.claude-plugin/plugin.json` (minor bump). Do not touch
`marketplace.json` or any `synergy-version` stamp - lefthook's `version-sync` derives them on
commit.

- [ ] **Step 4: Run the full suite**

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm check:artifact-drift
```
Expected: PASS. `check:artifact-drift` must be clean - if it is not, run `pnpm build:runtime` and
commit the regenerated bundles.

- [ ] **Step 5: Commit**

```bash
git add skills/review/SKILL.md CLAUDE.md .claude-plugin/plugin.json marketplace.json packages
git commit -m "feat(review): explain every removal and link where the logic went"
```

---

## Notes for the implementer

- **Where the excerpt comes from.** The design says resolution happens at read time. In practice
  read-time resolution is split: mapping a `movedTo` onto a captured item is pure and happens in
  the browser (Task 2), while reading a file that is *not* in the review needs git, which no
  browser host has. So the excerpt is captured once during `analysis-set` (Task 5) and stored on
  the immutable revision. This keeps the revision self-contained and exact.
- **Backward compatibility.** Revisions captured before this change have no `removals`, and their
  runs will report `covered: false`. That is correct - they were never explained - but it must not
  make an already-finalized revision unopenable. The gate runs only inside `analysis-set`, never
  in `deriveReviewReadiness`, so a finalized old revision stays readable.
