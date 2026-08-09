# Review Storytelling Walkthrough Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add agent-authored narrative (review summary + chapter intros + deliberate ordering) and a paced-reveal walkthrough UI to Synergy guided reviews, on both the web preview and the VS Code pane.

**Architecture:** Story order is array order (already the render order everywhere); the only new persisted data is two optional text fields at schemaVersion 1: `summary` on the insights root and `intro` on each group. The walkthrough cursor reuses the existing-but-unused `ReviewProgress.activeGroupId/activeFile/activeReviewItemId` fields, written through a new store helper and a widened progress PATCH. UIs feature-detect `summary` to enable walkthrough mode; old revisions render unchanged.

**Tech Stack:** TypeScript strict, pnpm workspaces, vitest, ajv (review-core schemas), React + Vite (preview), plain-JS webview (`media/panel.js`, vscode-extension).

**Spec:** `docs/superpowers/specs/2026-08-10-review-storytelling-design.md`. The approved visual prototype is `.lavish/review-storytelling-mock.html` — match its structure and tone.

## Global Constraints

- All new persisted fields are OPTIONAL at `schemaVersion: 1`. Never bump schemaVersion; never require the new fields on read.
- `summary`: trimmed non-blank string, max 600 chars. `intro`: trimmed non-blank string, max 300 chars.
- No hardcoded palette hex values in preview CSS — Ember & Graphite tokens (`--syn-*`) only.
- No em dash in any authored text, docs, commits, or UI copy — plain dash.
- pnpm only. Run package tests with `pnpm --filter <pkg> test -- <file>`.
- Plugin version in `.claude-plugin/plugin.json` must be bumped in the final task (behavior change under `skills/` + `packages/`); never hand-edit marketplace.json or `synergy-version` stamps — lefthook derives them.
- Commits: conventional format, no AI attribution of any kind.
- The walkthrough reveal cursor is monotonic: it only ever advances, enforced store-side.
- Work happens on branch `feat/review-storytelling` (already created).

## File Structure

| File | Responsibility |
|---|---|
| `packages/cli/src/review-analysis.ts` (+ `.schema.json`, tests) | Parse/validate `summary` + `intro` in analysis input |
| `packages/review-core/src/types.ts`, `schema.ts` (+ tests) | Persisted optional `summary`/`intro`; walkthrough position types |
| `packages/cli/src/review-actions.ts` (+ tests) | Copy narrative fields into persisted `ReviewInsights` (diff + scope) |
| `packages/review-core/src/store.ts` (+ tests) | `patchWalkthroughPosition` with monotonic guard |
| `packages/preview/src/server/review-api.ts` (+ tests) | Widen PATCH progress to accept `active*` cursor keys |
| `packages/preview/src/review/walkthrough.ts` (new, + test) | Pure story-order helpers: chapter list, cursor comparison, next-position |
| `packages/preview/src/review/ReviewShell.tsx`, `ReviewSidebar.tsx`, `ReviewStage.tsx`, `HunkTabs.tsx`, `ReviewHeader.tsx`, `review-state.ts`, `useReviewOperations.ts`, `review.css` | Walkthrough UI: summary bar, locked chapters, intro card, continue bar, reveal-all, cursor persistence |
| `packages/vscode-extension/src/panel/serialize.ts`, `media/panel.js`, `src/panel/ReviewViewProvider.ts` (+ tests) | Pane parity: summary card, intros, paced reveal, shared cursor |
| `skills/review/SKILL.md` | Narrative-ordering contract for the authoring agent |
| `.claude-plugin/plugin.json` | Version bump |

---

### Task 1: Analysis input accepts `summary` and `intro`

**Files:**
- Modify: `packages/cli/src/review-analysis.ts`
- Modify: `packages/cli/src/review-analysis.schema.json`
- Test: `packages/cli/src/review-analysis.test.ts`

**Interfaces:**
- Produces: `ReviewAnalysisInput` gains optional `summary?: string` on both union arms; `ScopeAnalysisGroupInput` and the diff-group return gain optional `intro?: string`. Exported const `MAX_SUMMARY_LENGTH = 600`, `MAX_INTRO_LENGTH = 300`.
- Consumes: existing assert helpers in `review-analysis.ts` (`assertString`, `assertOnlyKeys`, `fail`).

- [ ] **Step 1: Write failing tests**

Add to `packages/cli/src/review-analysis.test.ts` (follow the file's existing valid-payload fixtures; `validDiffPayload()`/`validScopePayload()` style helpers already exist — if named differently, reuse whatever the file uses to build a passing payload):

```ts
describe('narrative fields', () => {
  it('accepts a diff payload with summary and group intro', () => {
    const payload = validDiffPayload();
    payload.summary = 'Adds rate limiting. First the middleware, then the engine.';
    payload.groups[0].intro = 'Start here: every request passes through this middleware.';
    const parsed = parseReviewAnalysisInput(payload);
    expect(parsed.summary).toBe(payload.summary);
    expect(parsed.groups[0].intro).toBe(payload.groups[0].intro);
  });

  it('accepts a scope payload with summary and group intro', () => {
    const payload = validScopePayload();
    payload.summary = 'Maps the subscription lifecycle.';
    payload.groups[0].intro = 'The capture path frames everything else.';
    const parsed = parseReviewAnalysisInput(payload);
    expect(parsed.summary).toBe(payload.summary);
    expect(parsed.groups[0].intro).toBe(payload.groups[0].intro);
  });

  it('omits narrative fields when absent', () => {
    const parsed = parseReviewAnalysisInput(validDiffPayload());
    expect('summary' in parsed).toBe(false);
    expect('intro' in parsed.groups[0]).toBe(false);
  });

  it('rejects blank and over-length narrative fields', () => {
    const blank = validDiffPayload();
    blank.summary = '   ';
    expect(() => parseReviewAnalysisInput(blank)).toThrow('$.summary must be a non-empty string');

    const longSummary = validDiffPayload();
    longSummary.summary = 'x'.repeat(601);
    expect(() => parseReviewAnalysisInput(longSummary)).toThrow(
      '$.summary must contain at most 600 characters',
    );

    const longIntro = validDiffPayload();
    longIntro.groups[0].intro = 'x'.repeat(301);
    expect(() => parseReviewAnalysisInput(longIntro)).toThrow(
      '$.groups[0].intro must contain at most 300 characters',
    );
  });
});
```

- [ ] **Step 2: Run tests, verify failure**

Run: `pnpm --filter @synergy/cli test -- review-analysis`
Expected: FAIL — `$.summary is not allowed` (strict key allow-list rejects it).

- [ ] **Step 3: Implement parser support**

In `packages/cli/src/review-analysis.ts`:

```ts
export const MAX_SUMMARY_LENGTH = 600;
export const MAX_INTRO_LENGTH = 300;

function assertBoundedText(value: unknown, path: string, max: number): asserts value is string {
  assertString(value, path);
  if (Array.from(value).length > max) {
    fail(path, `must contain at most ${max} characters`);
  }
}
```

Type changes: add `summary?: string` to both arms of `ReviewAnalysisInput`; add `intro?: string` to `ScopeAnalysisGroupInput`. Diff groups are typed as `ReviewGroup` from review-core — Task 2 adds `intro?` there; until Task 2 lands, type the diff-group parse return as `ReviewGroup & { intro?: string }` and drop the intersection in Task 3 when review-core exports the field.

In `parseDiffGroup` and `parseScopeGroup`: extend `assertOnlyKeys` with `'intro'`, then:

```ts
if (value.intro !== undefined) assertBoundedText(value.intro, `${path}.intro`, MAX_INTRO_LENGTH);
// and in the returned object:
...(value.intro === undefined ? {} : { intro: value.intro }),
```

In `parseDiffAnalysis` / `parseScopeAnalysis`: extend root `assertOnlyKeys` with `'summary'` (both functions), validate and spread the same way with `MAX_SUMMARY_LENGTH`. Also extend the top-level `assertOnlyKeys` in `parseReviewAnalysisInput` (line ~326) with `'summary'`.

In `packages/cli/src/review-analysis.schema.json`: add to both `$defs.diffAnalysis.properties` and `$defs.scopeAnalysis.properties`:

```json
"summary": { "type": "string", "minLength": 1, "maxLength": 600, "pattern": "\\S" }
```

and to `$defs.diffGroup.properties` and `$defs.scopeGroup.properties`:

```json
"intro": { "type": "string", "minLength": 1, "maxLength": 300, "pattern": "\\S" }
```

Do not add them to `required`.

- [ ] **Step 4: Run tests, verify pass**

Run: `pnpm --filter @synergy/cli test -- review-analysis`
Expected: PASS, including the existing parser/schema agreement tests.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/review-analysis.ts packages/cli/src/review-analysis.schema.json packages/cli/src/review-analysis.test.ts
git commit -m "feat(cli): accept summary and group intro in review analysis input"
```

---

### Task 2: review-core persists narrative fields

**Files:**
- Modify: `packages/review-core/src/types.ts` (ReviewGroup ~line 187, ReviewInsights ~line 199)
- Modify: `packages/review-core/src/schema.ts` (`reviewInsightsSchema` ~line 301)
- Test: `packages/review-core/src/schema.test.ts` (or the existing test file covering `assertReviewInsights`; find with `grep -rn "assertReviewInsights" packages/review-core/src/*.test.ts`)

**Interfaces:**
- Produces: `ReviewGroup.intro?: string`; `ReviewInsights.summary?: string`. Consumed by Tasks 3-8.
- Consumes: existing `nonEmptyString` schema const in `schema.ts`.

- [ ] **Step 1: Write failing tests**

```ts
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
```

- [ ] **Step 2: Run tests, verify failure**

Run: `pnpm --filter @synergy/review-core test -- schema`
Expected: FAIL — `additionalProperties: false` rejects `summary`/`intro`.

- [ ] **Step 3: Implement**

`types.ts`:

```ts
export interface ReviewGroup {
  id: string;
  label: string;
  intro?: string;
  reviewItemIds: string[];
}

export interface ReviewInsights {
  schemaVersion: 1;
  revisionId: string;
  summary?: string;
  groups: ReviewGroup[];
  items: ReviewItemInsight[];
  files?: ReviewFileInsight[];
}
```

`schema.ts` `reviewInsightsSchema`: add `summary: nonEmptyString` to root `properties` and `intro: nonEmptyString` to the group item `properties`. Do not touch `required`.

- [ ] **Step 4: Run tests, verify pass**

Run: `pnpm --filter @synergy/review-core test`
Expected: PASS (full package — store/reconcile tests must not regress).

- [ ] **Step 5: Commit**

```bash
git add packages/review-core/src/types.ts packages/review-core/src/schema.ts packages/review-core/src/*.test.ts
git commit -m "feat(review-core): optional summary and group intro on persisted insights"
```

---

### Task 3: analysis-set copies narrative through (diff + scope)

**Files:**
- Modify: `packages/cli/src/review-actions.ts` (`translateScopeAnalysis` ~line 440, diff/scope insight assembly ~lines 539, 571)
- Modify: `packages/cli/src/review-analysis.ts` (drop the Task 1 `& { intro?: string }` intersection — `ReviewGroup` now carries it)
- Test: `packages/cli/src/review-actions.test.ts`, extend `packages/cli/src/review-e2e.test.ts`

**Interfaces:**
- Consumes: `ReviewAnalysisInput.summary`, group `intro` (Task 1); `ReviewInsights.summary`, `ReviewGroup.intro` (Task 2).
- Produces: persisted `insights.json` / `bundle.json` carrying `summary` + `intro`.

- [ ] **Step 1: Write failing tests**

In `review-actions.test.ts`, next to the existing `applyReviewAnalysis` tests (reuse their store/snapshot fixtures):

```ts
it('persists summary and group intro for a diff analysis', async () => {
  // reuse the file's existing fixture that builds a diff bundle + valid analysis
  const analysis = validDiffAnalysisFixture();
  analysis.summary = 'This PR adds rate limiting; middleware first, then the engine.';
  analysis.groups[0].intro = 'Every request passes through here first.';
  const result = await applyReviewAnalysis({ ...baseRequest, analysis }, deps);
  const insights = readPersistedInsights(); // fixture helper reading insights.json
  expect(insights.summary).toBe(analysis.summary);
  expect(insights.groups[0].intro).toBe(analysis.groups[0].intro);
});

it('persists summary and group intro for a scope analysis', async () => {
  const analysis = validScopeAnalysisFixture();
  analysis.summary = 'Walks the subscription lifecycle.';
  analysis.groups[0].intro = 'Capture comes before projection.';
  await applyReviewAnalysis({ ...scopeRequest, analysis }, deps);
  const insights = readPersistedInsights();
  expect(insights.summary).toBe(analysis.summary);
  expect(insights.groups[0].intro).toBe(analysis.groups[0].intro);
});
```

Extend `review-e2e.test.ts`: in the existing end-to-end diff flow, add `summary` + one `intro` to the submitted analysis and assert the bundle returned by `review status --json` (or `store.readBundle`) exposes both.

- [ ] **Step 2: Run tests, verify failure**

Run: `pnpm --filter @synergy/cli test -- review-actions review-e2e`
Expected: FAIL — persisted insights have no `summary`/`intro` (dropped during assembly).

- [ ] **Step 3: Implement**

Diff path (~line 571): the analysis groups already ARE the persisted groups, so `intro` flows automatically once types align; add summary:

```ts
const insights: ReviewInsights = {
  schemaVersion: 1,
  revisionId: request.reference.revisionId,
  ...(diffAnalysis.summary === undefined ? {} : { summary: diffAnalysis.summary }),
  groups: diffAnalysis.groups,
  items: diffAnalysis.items,
  ...(diffFiles ? { files: diffFiles } : {}),
};
```

Scope path: `translateScopeAnalysis` rebuilds groups — carry `intro` there:

```ts
const groups = analysis.groups.map(
  (group): ReviewGroup => ({
    id: group.id,
    label: group.label,
    ...(group.intro === undefined ? {} : { intro: group.intro }),
    reviewItemIds: group.sectionKeys.map(/* unchanged */),
  }),
);
```

and spread `...(scopeAnalysis.summary === undefined ? {} : { summary: scopeAnalysis.summary })` into the scope-path `insights` object (~line 539). In `assertValidAnalysis`, add trim/length guards mirroring the parser (defense in depth for the canonical shape):

```ts
if (analysis.summary !== undefined) assertNarrativeText(analysis.summary, 600, 'review summary');
for (const group of analysis.groups) {
  if (group.intro !== undefined) assertNarrativeText(group.intro, 300, `group intro: ${group.id}`);
}
// helper:
function assertNarrativeText(value: string, max: number, label: string): void {
  if (value.trim().length === 0 || Array.from(value).length > max) {
    throw new Error(`${label} must be 1-${max} characters`);
  }
}
```

Note: `CanonicalReviewAnalysis` (the type `assertValidAnalysis` receives) must also carry `summary?` — it lives in `review-actions.ts`; extend it.

- [ ] **Step 4: Run tests, verify pass**

Run: `pnpm --filter @synergy/cli test`
Expected: PASS (whole package).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/review-actions.ts packages/cli/src/review-analysis.ts packages/cli/src/review-actions.test.ts packages/cli/src/review-e2e.test.ts
git commit -m "feat(cli): persist narrative summary and intros through analysis-set"
```

---

### Task 4: store walkthrough cursor with monotonic guard

**Files:**
- Modify: `packages/review-core/src/types.ts` (add `WalkthroughPosition`)
- Modify: `packages/review-core/src/store.ts` (new method next to `patchItemProgress` ~line 1221)
- Modify: `packages/review-core/src/index.ts` (export the type)
- Test: `packages/review-core/src/store.test.ts` (or create `packages/review-core/src/walkthrough-position.test.ts` reusing store test fixtures)

**Interfaces:**
- Produces:

```ts
export interface WalkthroughPosition {
  activeGroupId: string;
  activeReviewItemId: string;
  activeFile?: string;
}
// store method:
patchWalkthroughPosition(
  workspaceId: string,
  revisionId: string,
  position: WalkthroughPosition,
): ReviewProgress;
```

- Consumes: existing `withLock`, `readFinalizedBundle`, `validateRevisionRelationships`, `publishProgress`, `nextProgressUpdatedAt` internals of `store.ts` (same pattern as `patchItemProgress`).

Semantics: story order = flatten `insights.groups[].reviewItemIds` in array order. A position is "later or equal" when its item's index in that flattened list is >= the stored position's index. Earlier positions are ignored (return current progress unchanged). Unknown group/item ids reject via existing `validateRevisionRelationships` (which already checks `activeGroupId` against groups); additionally reject when `activeReviewItemId` is not inside `activeGroupId`'s `reviewItemIds`.

- [ ] **Step 1: Write failing tests**

```ts
describe('patchWalkthroughPosition', () => {
  it('persists the cursor and returns updated progress', () => {
    const store = finalizedDiffStoreFixture(); // reuse existing fixture helper
    const progress = store.patchWalkthroughPosition('ws', 'rev', {
      activeGroupId: 'group-1',
      activeReviewItemId: secondItemId,
    });
    expect(progress.activeGroupId).toBe('group-1');
    expect(progress.activeReviewItemId).toBe(secondItemId);
  });

  it('ignores a position earlier than the stored cursor', () => {
    const store = finalizedDiffStoreFixture();
    store.patchWalkthroughPosition('ws', 'rev', {
      activeGroupId: 'group-2',
      activeReviewItemId: laterItemId,
    });
    const progress = store.patchWalkthroughPosition('ws', 'rev', {
      activeGroupId: 'group-1',
      activeReviewItemId: firstItemId,
    });
    expect(progress.activeReviewItemId).toBe(laterItemId);
  });

  it('rejects an item outside the named group', () => {
    const store = finalizedDiffStoreFixture();
    expect(() =>
      store.patchWalkthroughPosition('ws', 'rev', {
        activeGroupId: 'group-1',
        activeReviewItemId: itemFromGroup2,
      }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run tests, verify failure**

Run: `pnpm --filter @synergy/review-core test -- store`
Expected: FAIL — method does not exist.

- [ ] **Step 3: Implement**

In `store.ts`, mirror `patchItemProgress`'s read/validate/publish shape:

```ts
patchWalkthroughPosition(workspaceId, revisionId, position): ReviewProgress {
  return withLock(workspaceId, () => {
    const finalized = readFinalizedBundle(projectRoot, workspaceId, revisionId);
    const snapshot =
      finalized?.snapshot ??
      readValidated(snapshotFile(projectRoot, workspaceId, revisionId), assertReviewSnapshot);
    const insights =
      finalized?.insights ??
      readValidated(insightsFile(projectRoot, workspaceId, revisionId), assertReviewInsights);
    const current =
      finalized?.progress ??
      readValidated(progressFile(projectRoot, workspaceId, revisionId), assertReviewProgress);

    const group = insights.groups.find((candidate) => candidate.id === position.activeGroupId);
    if (!group) throw new Error(`unknown walkthrough group: ${position.activeGroupId}`);
    if (!group.reviewItemIds.includes(position.activeReviewItemId)) {
      throw new Error(
        `walkthrough item ${position.activeReviewItemId} is not in group ${position.activeGroupId}`,
      );
    }

    const storyOrder = insights.groups.flatMap((candidate) => candidate.reviewItemIds);
    const nextIndex = storyOrder.indexOf(position.activeReviewItemId);
    const currentIndex = current.activeReviewItemId
      ? storyOrder.indexOf(current.activeReviewItemId)
      : -1;
    if (nextIndex <= currentIndex) return current;

    const next: ReviewProgress = {
      ...current,
      activeGroupId: position.activeGroupId,
      activeReviewItemId: position.activeReviewItemId,
      ...(position.activeFile === undefined ? {} : { activeFile: position.activeFile }),
      updatedAt: nextProgressUpdatedAt(current.updatedAt, options.now?.() ?? Date.now()),
    };
    assertReviewProgress(next);
    const workspace = this.readWorkspace(workspaceId);
    validateRevisionRelationships(
      { ...workspace, source: snapshot.source, currentRevisionId: revisionId },
      snapshot,
      insights,
      next,
      finalized !== undefined,
    );
    publishProgress(projectRoot, workspaceId, revisionId, finalized, next, options);
    return next;
  });
},
```

Add the method signature to the store interface (~line 93 region) and `WalkthroughPosition` to `types.ts` + barrel export.

- [ ] **Step 4: Run tests, verify pass**

Run: `pnpm --filter @synergy/review-core test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/review-core/src/types.ts packages/review-core/src/store.ts packages/review-core/src/index.ts packages/review-core/src/*.test.ts
git commit -m "feat(review-core): monotonic walkthrough cursor on review progress"
```

---

### Task 5: preview API accepts the cursor

**Files:**
- Modify: `packages/preview/src/server/review-api.ts` (`parseProgress` ~line 240, PATCH dispatch ~line 270)
- Test: `packages/preview/src/server/review-api.test.ts` (find existing progress-PATCH tests: `grep -n "progress" packages/preview/src/server/review-api.test.ts`)

**Interfaces:**
- Consumes: `store.patchWalkthroughPosition` (Task 4).
- Produces: PATCH `/api/reviews/:ws/:rev/progress` accepts EITHER an item patch `{reviewItemId, status?, note?}` (unchanged) OR a cursor patch `{walkthrough: {activeGroupId, activeReviewItemId, activeFile?}}`. Response stays the fresh bundle. SSE progress frames broadcast automatically because `publishProgress` already drives them.

- [ ] **Step 1: Write failing tests**

```ts
it('accepts a walkthrough cursor patch and returns the fresh bundle', async () => {
  const response = await patchProgress({
    walkthrough: { activeGroupId: 'group-1', activeReviewItemId: firstItemId },
  });
  expect(response.status).toBe(200);
  expect(response.body.bundle.progress.activeReviewItemId).toBe(firstItemId);
});

it('rejects a patch mixing item and walkthrough keys', async () => {
  const response = await patchProgress({
    reviewItemId: firstItemId,
    status: 'reviewed',
    walkthrough: { activeGroupId: 'group-1', activeReviewItemId: firstItemId },
  });
  expect(response.status).toBe(400);
});

it('rejects a walkthrough patch with unknown ids', async () => {
  const response = await patchProgress({
    walkthrough: { activeGroupId: 'nope', activeReviewItemId: firstItemId },
  });
  expect(response.status).toBe(400);
});
```

- [ ] **Step 2: Run tests, verify failure**

Run: `pnpm --filter @synergy/preview test -- review-api`
Expected: FAIL — `walkthrough is not allowed` (assertOnlyKeys).

- [ ] **Step 3: Implement**

In `review-api.ts`, branch `parseProgress` into a discriminated result:

```ts
type ProgressPatch =
  | { kind: 'item'; reviewItemId: string; patch: { status?: 'reviewed' | 'needs-review'; note?: string | null } }
  | { kind: 'walkthrough'; position: WalkthroughPosition };

function parseProgress(value: unknown, bundle: ReviewBundle): ProgressPatch {
  if (!isRecord(value)) throw new ReviewApiError(400, 'invalid_request');
  if ('walkthrough' in value) {
    assertOnlyKeys(value, ['walkthrough']);
    const cursor = value.walkthrough;
    if (!isRecord(cursor)) throw new ReviewApiError(400, 'invalid_request');
    assertOnlyKeys(cursor, ['activeGroupId', 'activeReviewItemId', 'activeFile']);
    if (typeof cursor.activeGroupId !== 'string' || typeof cursor.activeReviewItemId !== 'string') {
      throw new ReviewApiError(400, 'invalid_request');
    }
    if (cursor.activeFile !== undefined && typeof cursor.activeFile !== 'string') {
      throw new ReviewApiError(400, 'invalid_request');
    }
    if (!bundle.insights.groups.some((group) => group.id === cursor.activeGroupId)) {
      throw new ReviewApiError(400, 'invalid_walkthrough_position');
    }
    getItem(bundle, cursor.activeReviewItemId);
    return {
      kind: 'walkthrough',
      position: {
        activeGroupId: cursor.activeGroupId,
        activeReviewItemId: cursor.activeReviewItemId,
        ...(cursor.activeFile === undefined ? {} : { activeFile: cursor.activeFile }),
      },
    };
  }
  // existing item-patch body, wrapped as { kind: 'item', ... }
}
```

At the dispatch site (~line 270), call `store.patchWalkthroughPosition(...)` for `kind: 'walkthrough'`, `store.patchItemProgress(...)` for `kind: 'item'`; both keep returning the fresh bundle. Store-level errors (unknown item-in-group) surface as 400: wrap the walkthrough store call in try/catch and rethrow `new ReviewApiError(400, 'invalid_walkthrough_position')`.

- [ ] **Step 4: Run tests, verify pass**

Run: `pnpm --filter @synergy/preview test -- review-api`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/preview/src/server/review-api.ts packages/preview/src/server/review-api.test.ts
git commit -m "feat(preview): walkthrough cursor patches on the review progress API"
```

---

### Task 6: walkthrough story helpers (pure logic)

**Files:**
- Create: `packages/preview/src/review/walkthrough.ts`
- Test: `packages/preview/src/review/walkthrough.test.ts`

**Interfaces:**
- Produces (consumed by Tasks 7-8):

```ts
export interface Chapter {
  group: ReviewGroup;          // carries intro?
  index: number;               // 0-based chapter number
  items: ReviewItem[];         // story order within the chapter
  paths: string[];             // first-appearance file order
}

export function walkthroughEnabled(insights: ReviewInsights): boolean; // insights.summary !== undefined
export function buildChapters(insights: ReviewInsights, items: ReviewItem[]): Chapter[];
export function storyIndexOf(chapters: Chapter[], reviewItemId: string): number; // -1 when unknown
export function chapterOf(chapters: Chapter[], reviewItemId: string): Chapter | undefined;
export function revealedChapterCount(chapters: Chapter[], cursorItemId: string | undefined): number;
// cursor undefined -> 1 (first chapter open); otherwise index of cursor's chapter + 1
export function nextPosition(
  chapters: Chapter[],
  currentItemId: string,
): { reviewItemId: string; groupId: string } | undefined; // next item in story order, undefined at end
```

- Consumes: `ReviewGroup`, `ReviewInsights`, `ReviewItem` types only — no React, no fetch. Keep this file dependency-free so it is trivially testable and reusable.

- [ ] **Step 1: Write failing tests**

```ts
const items = [
  { id: 'a1', path: 'src/hooks/useAuth.ts' },
  { id: 'a2', path: 'src/hooks/useAuth.ts' },
  { id: 'b1', path: 'src/store/authStore.ts' },
] as ReviewItem[];
const insights = {
  schemaVersion: 1,
  revisionId: 'rev-1',
  summary: 'Story.',
  groups: [
    { id: 'entry', label: 'Entry', intro: 'Start.', reviewItemIds: ['a1', 'a2'] },
    { id: 'core', label: 'Core', reviewItemIds: ['b1'] },
  ],
  items: [],
} as ReviewInsights;

it('builds chapters in group array order with first-appearance paths', () => {
  const chapters = buildChapters(insights, items);
  expect(chapters.map((chapter) => chapter.group.id)).toEqual(['entry', 'core']);
  expect(chapters[0].paths).toEqual(['src/hooks/useAuth.ts']);
  expect(chapters[0].items.map((item) => item.id)).toEqual(['a1', 'a2']);
});

it('walkthroughEnabled requires a summary', () => {
  expect(walkthroughEnabled(insights)).toBe(true);
  expect(walkthroughEnabled({ ...insights, summary: undefined })).toBe(false);
});

it('reveals only the first chapter with no cursor', () => {
  const chapters = buildChapters(insights, items);
  expect(revealedChapterCount(chapters, undefined)).toBe(1);
  expect(revealedChapterCount(chapters, 'b1')).toBe(2);
});

it('nextPosition walks the story order and ends', () => {
  const chapters = buildChapters(insights, items);
  expect(nextPosition(chapters, 'a2')).toEqual({ reviewItemId: 'b1', groupId: 'core' });
  expect(nextPosition(chapters, 'b1')).toBeUndefined();
});
```

- [ ] **Step 2: Run, verify failure** — `pnpm --filter @synergy/preview test -- walkthrough` — FAIL (module missing).

- [ ] **Step 3: Implement** — straightforward map/flatMap over groups; skip item ids missing from the snapshot map (defensive, same as `orderedItems` in `ReviewShell.tsx`).

- [ ] **Step 4: Run, verify pass** — `pnpm --filter @synergy/preview test -- walkthrough` — PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/preview/src/review/walkthrough.ts packages/preview/src/review/walkthrough.test.ts
git commit -m "feat(preview): pure walkthrough story-order helpers"
```

---

### Task 7: preview walkthrough state + cursor persistence

**Files:**
- Modify: `packages/preview/src/review/review-state.ts` (reducer + state shape)
- Modify: `packages/preview/src/review/useReviewOperations.ts` (add `advanceWalkthrough` op calling PATCH)
- Modify: `packages/preview/src/review/ReviewProvider.tsx` (expose new op + derived walkthrough data)
- Test: `packages/preview/src/review/review-state.test.ts` (create if absent, colocated like other tests)

**Interfaces:**
- Consumes: Task 6 helpers; PATCH body `{walkthrough: {...}}` (Task 5).
- Produces (for Task 8's components, via `useReview()`):

```ts
// added to the review context value:
walkthrough: {
  enabled: boolean;
  chapters: Chapter[];
  revealedCount: number;        // derived: max(server cursor, local reveals) chapter count
  revealAll: boolean;           // local UI flag
  advanceTo(reviewItemId: string): void;  // sets active item AND persists cursor (fire-and-forget PATCH)
  setRevealAll(): void;
}
```

Rules: reveal state derives from `bundle.progress.activeReviewItemId` (server, survives reload) combined with a local `revealAll` boolean (session-only). `advanceTo` always calls `setActiveItem` and, when the target extends the story position, issues the walkthrough PATCH; the store's monotonic guard makes double-sends harmless. SSE progress frames already refresh the bundle, so a cursor advanced in the VS Code pane appears here without new wiring.

- [ ] **Step 1: Write failing tests** — reducer-level:

```ts
it('tracks revealAll as a session flag', () => {
  const state = reducer(initialState, { type: 'walkthrough-reveal-all' });
  expect(state.walkthroughRevealAll).toBe(true);
});

it('does not regress the revealed chapter count when the bundle cursor is behind', () => {
  // revealedCount derivation lives in walkthrough.ts (revealedChapterCount) — assert
  // the provider selector picks max(local, server): simulate bundle cursor at chapter 1
  // after a local advance to chapter 2.
  const chapters = buildChapters(insightsFixture, itemsFixture);
  expect(
    Math.max(revealedChapterCount(chapters, 'b1'), revealedChapterCount(chapters, 'a1')),
  ).toBe(2);
});
```

- [ ] **Step 2: Run, verify failure** — `pnpm --filter @synergy/preview test -- review-state` — FAIL.

- [ ] **Step 3: Implement.** Add `walkthroughRevealAll: boolean` to reducer state (reset on bundle identity change), a `'walkthrough-reveal-all'` action, and in `useReviewOperations.ts`:

```ts
async function advanceWalkthrough(position: { activeGroupId: string; activeReviewItemId: string; activeFile?: string }) {
  await patchReview(reference, 'progress', { walkthrough: position }); // reuse the existing PATCH helper used by markProgress
}
```

`ReviewProvider` composes the context value: `chapters = useMemo(() => buildChapters(insights, orderedItems), ...)`; `revealedCount = revealAll ? chapters.length : Math.max(revealedChapterCount(chapters, progress.activeReviewItemId), localFloor)` where `localFloor` tracks the highest chapter the user has visited this session (a `useRef` bumped inside `advanceTo`). `advanceTo(id)` = `setActiveItem(id)`; look up chapter via `chapterOf`; fire `advanceWalkthrough` without awaiting (log-and-ignore failure; cursor is a convenience, never blocks navigation).

- [ ] **Step 4: Run, verify pass** — `pnpm --filter @synergy/preview test` — PASS (whole package).

- [ ] **Step 5: Commit**

```bash
git add packages/preview/src/review/review-state.ts packages/preview/src/review/useReviewOperations.ts packages/preview/src/review/ReviewProvider.tsx packages/preview/src/review/review-state.test.ts
git commit -m "feat(preview): walkthrough reveal state and cursor persistence"
```

---

### Task 8: preview walkthrough UI

**Files:**
- Modify: `packages/preview/src/review/ReviewShell.tsx` (summary bar mount, Continue keyboard flow)
- Modify: `packages/preview/src/review/ReviewHeader.tsx` (Reveal all button)
- Modify: `packages/preview/src/review/ReviewSidebar.tsx` (chapter numbers, locked/dimmed chapters, intro-aware outline)
- Modify: `packages/preview/src/review/ReviewStage.tsx` (chapter intro card, Continue bar)
- Modify: `packages/preview/src/review/HunkTabs.tsx` (story-order tabs with line-range labels)
- Modify: `packages/preview/src/review/review.css`
- Test: `packages/preview/src/review/walkthrough-ui.test.tsx` (new; use the package's existing component-test setup — check how sibling `.test.tsx` files render with providers)

**Interfaces:**
- Consumes: `useReview().walkthrough` (Task 7), `Chapter` (Task 6), tokens from `theme.css`.
- Produces: DOM classes `review-summary`, `review-chapter--locked`, `review-chapter-intro`, `review-continue` (used by tests).

Follow the approved prototype `.lavish/review-storytelling-mock.html` for structure and visual tone. Key behaviors:

1. **Summary bar** (in `ReviewShell`, between header and columns, only when `walkthrough.enabled`): accent left rail, "The story of this change" eyebrow, summary text, chapter progress dots (done = accent, current = accent 55% opacity, future = border color).
2. **Sidebar chapters**: number badge per group (accent-filled = current, outlined check = complete, dashed outline = locked); locked chapters render title + `· · ·` only (files hidden), `opacity: .48`, still clickable — clicking calls `advanceTo(firstItemOfChapter)`.
3. **Chapter intro card** (top of `ReviewStage` when enabled): `Ch. N` chip + group label + `group.intro` (omit paragraph when intro absent).
4. **Continue bar** (bottom of `ReviewStage`): shows next file in chapter, or next chapter teaser (`nextChapter.group.label` + first sentence of its intro), or "This was the final chapter."; primary button calls `advanceTo(nextPosition(...).reviewItemId)`; smooth-scroll stage to top after advance (`prefers-reduced-motion` respected via CSS `scroll-behavior`).
5. **HunkTabs**: when enabled, order tabs by the chapter's `reviewItemIds` order (not snapshot order) and label each `H<n> · L<start>-<end>` using `item.range`.
6. **Reveal all** (in `ReviewHeader`, only when enabled): pill button calling `walkthrough.setRevealAll()`.
7. **Feature detection**: every addition is behind `walkthrough.enabled`; disabled renders exactly today's UI.
8. All new CSS uses `--syn-*` tokens; focus-visible states on every new interactive element.

- [ ] **Step 1: Write failing component tests**

```tsx
it('renders the summary bar and locks later chapters when narrative is present', () => {
  renderReviewWithBundle(bundleWithNarrative); // fixture: summary + 2 groups with intros
  expect(screen.getByText('The story of this change')).toBeInTheDocument();
  expect(screen.getAllByRole('button', { name: /reveal all/i })).toHaveLength(1);
  const locked = document.querySelectorAll('.review-chapter--locked');
  expect(locked).toHaveLength(1); // second chapter locked initially
});

it('renders todays flat UI when no summary exists', () => {
  renderReviewWithBundle(bundleWithoutNarrative);
  expect(screen.queryByText('The story of this change')).not.toBeInTheDocument();
  expect(document.querySelector('.review-chapter--locked')).toBeNull();
});

it('Continue advances to the next chapter and unlocks it', async () => {
  renderReviewWithBundle(bundleWithNarrative);
  await userEvent.click(screen.getByRole('button', { name: /continue/i }));
  // after advancing past chapter 1's last item:
  expect(document.querySelector('.review-chapter--locked')).toBeNull();
});
```

- [ ] **Step 2: Run, verify failure** — `pnpm --filter @synergy/preview test -- walkthrough-ui` — FAIL.

- [ ] **Step 3: Implement components + CSS.** Structure per the prototype; representative pieces:

`ReviewShell` summary bar:

```tsx
{review.walkthrough.enabled ? (
  <section className="review-summary">
    <span className="review-summary__rail" aria-hidden="true" />
    <div>
      <p className="review-eyebrow">The story of this change</p>
      <p className="review-summary__text">{review.bundle.insights.summary}</p>
    </div>
    <div className="review-summary__progress">
      <span>
        Chapter {currentChapterIndex + 1} of {review.walkthrough.chapters.length}
      </span>
      <div className="review-summary__dots">
        {review.walkthrough.chapters.map((chapter) => (
          <i
            key={chapter.group.id}
            className={
              chapter.index < currentChapterIndex
                ? 'is-done'
                : chapter.index === currentChapterIndex
                  ? 'is-current'
                  : ''
            }
          />
        ))}
      </div>
    </div>
  </section>
) : null}
```

Continue bar in `ReviewStage` (props: `walkthrough`, `activeItemId`, passed from `ReviewShell`):

```tsx
const next = nextPosition(walkthrough.chapters, item.id);
const nextChapter = next && chapterOf(walkthrough.chapters, next.reviewItemId);
const crossesChapter = nextChapter && nextChapter.group.id !== currentChapter?.group.id;
// ...
<footer className="review-continue">
  <p>
    {next === undefined
      ? 'This was the final chapter.'
      : crossesChapter
        ? <>Next chapter: <strong>{nextChapter.group.label}</strong></>
        : <>Next file: <strong>{nextItemFileName}</strong></>}
  </p>
  {next ? (
    <button type="button" className="review-button review-button--primary"
      onClick={() => walkthrough.advanceTo(next.reviewItemId)}>
      {crossesChapter ? `Continue to chapter ${nextChapter.index + 1}` : 'Next'}
    </button>
  ) : null}
</footer>
```

CSS additions (`review.css`) — tokens only, e.g.:

```css
.review-summary {
  display: flex;
  gap: var(--syn-sp-4);
  padding: var(--syn-sp-4) var(--syn-sp-6);
  border-bottom: 1px solid var(--syn-border);
  background: linear-gradient(0deg, var(--syn-accent-soft), var(--syn-accent-soft)),
    var(--syn-bg-raised);
}
.review-chapter--locked {
  opacity: 0.48;
}
.review-chapter--locked .review-file {
  display: none;
}
```

Sidebar: wrap each existing group `<section className="review-group">` with chapter classes and the number badge; locked when `chapter.index >= walkthrough.revealedCount`; group heading becomes a button that calls `advanceTo(firstItem.id)`.

`HunkTabs`: accept the story-ordered `fileItems` (compute in `ReviewShell` from the active chapter's `reviewItemIds` filtered by path, falling back to current behavior when walkthrough disabled) and render labels `` `H${index + 1} · L${item.range.start}-${item.range.end}` ``.

- [ ] **Step 4: Run tests + typecheck + build** — `pnpm --filter @synergy/preview test && pnpm --filter @synergy/preview build` — PASS.

- [ ] **Step 5: Manual visual check.** Start preview against a dogfood review with narrative (create one via the CLI e2e fixture or a scratch repo), compare against `.lavish/review-storytelling-mock.html` side by side in light AND dark themes. Fix visual drift before committing.

- [ ] **Step 6: Commit**

```bash
git add packages/preview/src/review packages/preview/src/review/review.css
git commit -m "feat(preview): paced-reveal storytelling walkthrough UI"
```

---

### Task 9: VS Code pane parity

**Files:**
- Modify: `packages/vscode-extension/src/panel/serialize.ts` (bundle already embeds insights — verify `summary`/`intro` survive serialization; no change expected, add test)
- Modify: `packages/vscode-extension/media/panel.js` (`renderGroups` ~line 348, `renderGroup` ~line 335, `groupItemsByFile` ~line 137)
- Modify: `packages/vscode-extension/media/panel.css` (or the stylesheet `panel.js` pairs with — check `media/`)
- Modify: `packages/vscode-extension/src/panel/ReviewViewProvider.ts` (message handler for `advanceWalkthrough` → `store.patchWalkthroughPosition`)
- Test: `packages/vscode-extension/src/panel/serialize.test.ts` + provider suite (`grep -rn "describe" packages/vscode-extension/src/panel/*.test.ts` to find the harness; a vitest provider suite exists per repo history)

**Interfaces:**
- Consumes: `bundle.insights.summary`, `groups[].intro`, `bundle.progress.activeReviewItemId`, `store.patchWalkthroughPosition` (Task 4).
- Produces: webview message `{type: 'advanceWalkthrough', groupId, reviewItemId}` handled by the provider; re-post of the bundle after the write (existing fs-watcher/SSE path also covers it).

Behaviors (mirror Task 8, adapted to the pane):
1. Summary card above groups when `summary` present (title "The story of this change", chapter count).
2. Group header shows number badge + `intro` line beneath the label.
3. Groups past the cursor's chapter collapsed + dimmed, title-only; clicking the header sends `advanceWalkthrough` for the group's first item and expands it.
4. Continue button after the last item of each revealed chapter (except the last) sending `advanceWalkthrough` for the next chapter's first item.
5. "Reveal all" button in the pane toolbar area (webview-local flag, no persistence).
6. No `summary` → current flat rendering, byte-for-byte behavior.
7. Reveal derivation identical to Task 6's `revealedChapterCount`, reimplemented as a small helper inside `panel.js` (webview has no module imports): `revealedChapterCount(groups, cursorItemId)` walking `groups[].reviewItemIds`.

- [ ] **Step 1: Write failing tests.** Serialization: assert a bundle whose insights carry `summary`/`intro` round-trips through `serializeBundle` with both fields intact. Provider: assert an `advanceWalkthrough` webview message calls `patchWalkthroughPosition` with the message's ids (stub the store as the suite already stubs `setItemStatus`).

- [ ] **Step 2: Run, verify failure** — `pnpm --filter synergy-vscode test` (use the package's actual name from its package.json) — provider test FAIL (unknown message type).

- [ ] **Step 3: Implement.** Provider message handler (next to the existing `setStatus` case):

```ts
case 'advanceWalkthrough': {
  const store = createReviewStore(root);
  store.patchWalkthroughPosition(message.workspaceId, message.revisionId, {
    activeGroupId: message.groupId,
    activeReviewItemId: message.reviewItemId,
  });
  await this.postBundle(); // whatever the provider's existing re-post method is named
  break;
}
```

`panel.js`: render summary card + intro lines + locked state; all styling in the pane stylesheet using the extension's existing VS Code theme variables (`--vscode-*`) — the pane must feel native to the editor while matching the walkthrough structure. Continue/locked-header clicks `vscode.postMessage({type: 'advanceWalkthrough', ...})`.

- [ ] **Step 4: Run, verify pass** — extension package tests + `pnpm --filter <ext> build` (esbuild bundle) — PASS.

- [ ] **Step 5: Manual check.** Load the .vsix (or extension dev host) against the same dogfood review used in Task 8 Step 5; verify cursor advanced in the pane appears in the web preview and vice versa; verify no-narrative revisions render as before.

- [ ] **Step 6: Commit**

```bash
git add packages/vscode-extension
git commit -m "feat(vscode): storytelling walkthrough parity in the review pane"
```

---

### Task 10: skill narrative contract + version bump

**Files:**
- Modify: `skills/review/SKILL.md` (step 3)
- Modify: `.claude-plugin/plugin.json` (version bump, minor)

**Interfaces:**
- Consumes: input schema from Task 1 (`summary`, `intro`).
- Produces: the authoring contract agents follow; version stamps derived by lefthook on commit.

- [ ] **Step 1: Update SKILL.md step 3.** Insert a "Narrative ordering" subsection before the payload example containing exactly these rules (adapt wording to the file's voice, keep every rule):

- Plan the story before writing the payload. Order by consumer-first call-chain descent: start at the entry points a user or caller actually touches (screens, routes, hooks, public API), then descend the call chain one level at a time so every file is motivated by a consumer the reviewer has just read. Implementation cores, stores, types, and plumbing appear only after the code that needs them. Never types-first, never alphabetical. Find the order by tracing imports/callers downward from user-visible surfaces.
- Array order IS the walkthrough order: `groups[]` = chapter order; `reviewItemIds[]` / `sectionKeys[]` = page order (files by first appearance, hunks by position). Order them deliberately.
- Always provide `summary` (2-4 sentences, max 600 chars): what the change does, why, and the route the review takes.
- Give each group an `intro` (1-2 sentences, max 300 chars) written as a hand-off: why this chapter now, what to check.
- Exception: when one large unit genuinely is the right starting point, lead with it and say so in its intro; the default is gradual buildup.
- Worked example (include verbatim): wrong order starts at `authTransitionStore.ts`; right order starts at the auth entry hooks (`useAppleAuth` / `useGoogleAuth` / `useEmailAuth`) which call `usePostAuthFlow`, which calls `beginAuthTransition` - only then the store, whose necessity is by then self-evident.

Update the example JSON payload in SKILL.md to include `summary` and one group `intro`.

- [ ] **Step 2: Bump version.** Edit `.claude-plugin/plugin.json` version minor bump (e.g. 0.16.0 → 0.17.0). Do NOT touch marketplace.json or `synergy-version` stamps — lefthook `version-sync` derives them on commit.

- [ ] **Step 3: Verify.** `git commit` and confirm the lefthook `version-sync` hook ran and updated stamps (check `git show --stat HEAD` includes the derived files). Run repo-wide `pnpm test` for a final green sweep and `pnpm --filter @synergy/cli build` so `dist/cli.js` reflects the new parser (the skill invokes the built CLI; repo may have a build step wired into release — follow whatever `f92943d`-style rebuild the repo history shows).

- [ ] **Step 4: Commit**

```bash
git add skills/review/SKILL.md .claude-plugin/plugin.json packages/cli/dist
git commit -m "feat(skills): narrative storytelling contract for guided review analysis"
```

---

## Self-Review (completed)

- Spec coverage: data model (T1-T3), skill contract (T10), preview walkthrough incl. persistence/monotonicity (T4-T8), pane parity (T9), API plumbing (T5), UX quality bar (T8 steps 3/5, T9 step 5), error handling (T1/T4/T5 reject cases), testing section (each task's TDD steps + e2e in T3). No gaps found.
- Placeholder scan: clean; every step carries concrete code or an exact command.
- Type consistency: `WalkthroughPosition` (T4) used by T5/T9; `Chapter`/`nextPosition`/`revealedChapterCount` (T6) used by T7/T8; `summary`/`intro` names identical across T1-T3 and schemas.
