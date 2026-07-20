# Review Analysis Efficiency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Synergy `0.13.0` with a compact scoped-analysis contract that lets an agent submit local section keys and repository-aware descriptions while the CLI derives durable identities, enforces full coverage, and reports time-to-review-ready.

**Architecture:** Pure CLI modules derive granularity guidance, validate exact captured-line coverage, and strictly parse a scoped payload. `review analysis-set` translates local keys to canonical Review Core item IDs in one atomic finalization. Diff analysis keeps its current durable-item contract, and preview readiness remains an independent reported state.

**Tech Stack:** TypeScript 5.6, Node.js 20, pnpm 10.28.2, CAC, Ajv-backed Review Core schemas, Vitest.

## Global Constraints

- Base this PR on merged PR1 so it can use healthy runtime status and full URL output.
- Do not expose `applyCodeSections`, content hashes, location hashes, or opaque IDs to scoped-analysis agents.
- Keep descriptions agent-authored, concise, and repository-aware; tooling validates structure, not meaning.
- Cover every captured text line exactly once; binary files have no sections.
- Reject unknown JSON keys and mixed diff/scope contracts.
- Finalization remains one atomic publication; no partially translated analysis may become visible.
- Keep diff review payload compatibility.
- Subagents do not commit. The root integrator runs listed commit steps after review.

---

### Task 1: Derive bounded scope granularity guidance

**Files:**
- Create: `packages/cli/src/review-analysis-guidance.ts`
- Create: `packages/cli/src/review-analysis-guidance.test.ts`
- Modify: `packages/cli/src/review-actions.ts`
- Modify: `packages/cli/src/review-actions.test.ts`

**Interfaces:**

```ts
export interface ReviewAnalysisGuidance {
  textFiles: number;
  textLines: number;
  minimumSections: number;
  targetSections: number;
  maximumSections: number;
  scopeTooBroad: boolean;
}

export function deriveReviewAnalysisGuidance(snapshot: ReviewSnapshot): ReviewAnalysisGuidance;
```

For `f` text files and `l` captured text lines:

```ts
minimum = Math.max(f, Math.min(30, Math.ceil(l / 150)));
target = Math.max(f, Math.min(30, Math.ceil(l / 120)));
maximum = Math.max(f, Math.min(30, Math.ceil(l / 100)));
scopeTooBroad = f > 30 || l > 4500;
```

- [ ] **Step 1: Write table-driven failing tests**

Include empty scope, one short file, 15 files/3,035 lines (`21/26/30`), more than 30 files, more than 4,500 lines, and binary files excluded from both counts.

- [ ] **Step 2: Run and observe failure**

Run: `pnpm --filter @synergy/cli test -- review-analysis-guidance.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the pure calculation**

Read only immutable captured snapshot data. Return integers and never mutate the snapshot.

- [ ] **Step 4: Expose guidance from create and status results**

Add guidance only for scope reviews. Preserve existing fields and JSON stability for diff reviews.

- [ ] **Step 5: Verify**

Run: `pnpm --filter @synergy/cli test -- review-analysis-guidance.test.ts review-actions.test.ts`

Run: `pnpm --filter @synergy/cli typecheck`

Expected: PASS.

- [ ] **Step 6: Root integrator commit**

`git add packages/cli/src && git commit -m "feat(review): guide scoped analysis granularity"`

---

### Task 2: Enforce complete non-overlapping text coverage

**Files:**
- Create: `packages/cli/src/review-coverage.ts`
- Create: `packages/cli/src/review-coverage.test.ts`

**Interface:**

```ts
export interface ScopeSectionRange {
  key: string;
  path: string;
  start: number;
  end: number;
}

export function assertCompleteScopeCoverage(
  snapshot: ScopeReviewSnapshot,
  sections: readonly ScopeSectionRange[],
): void;
```

- [ ] **Step 1: Write failing coverage tests**

Cover exact single and multi-section files, a missing first/middle/last line, overlap, reversed range, nonexistent path, duplicate key, a text file with no sections, and a binary file incorrectly receiving a section. Error messages must name path and first offending range.

- [ ] **Step 2: Run and observe failure**

Run: `pnpm --filter @synergy/cli test -- review-coverage.test.ts`

Expected: FAIL because `review-coverage.ts` does not exist.

- [ ] **Step 3: Implement an O(n log n) validator**

Group by path, sort each file by `start` then `end`, require the first start to equal the captured first line, require each next start to equal prior end plus one, and require final end to equal the captured last line. Reject ranges for uncaptured/binary paths before applying sections.

- [ ] **Step 4: Verify**

Run: `pnpm --filter @synergy/cli test -- review-coverage.test.ts`

Expected: PASS.

- [ ] **Step 5: Root integrator commit**

`git add packages/cli/src/review-coverage* && git commit -m "feat(review): require complete scope coverage"`

---

### Task 3: Add the strict local-key scoped-analysis contract

**Files:**
- Create: `packages/cli/src/review-analysis.ts`
- Create: `packages/cli/src/review-analysis.test.ts`
- Modify: `packages/cli/src/review-cli.ts`
- Modify: `packages/cli/src/review-cli.test.ts`

**Contracts:**

```ts
export interface ScopeAnalysisSectionInput {
  key: string;
  path: string;
  label: string;
  parentLabel?: string;
  start: number;
  end: number;
  description: string;
  confidence: 'high' | 'medium' | 'low';
  evidencePaths: string[];
}

export interface ScopeAnalysisGroupInput {
  id: string;
  label: string;
  sectionKeys: string[];
}

export type ReviewAnalysisInput =
  | { kind: 'scope'; groups: ScopeAnalysisGroupInput[]; sections: ScopeAnalysisSectionInput[] }
  | { kind: 'diff'; groups: ReviewInsightGroup[]; items: Record<string, ReviewItemInsight> };

export function parseReviewAnalysisInput(value: unknown): ReviewAnalysisInput;
```

- [ ] **Step 1: Write failing strict-parser tests**

Accept valid diff and scope examples. Reject unknown top-level/nested keys, duplicate section keys, duplicate group IDs, missing key references, a section in multiple groups, an ungrouped section, empty descriptions/evidence, invalid confidence, and a mixed contract.

- [ ] **Step 2: Run and observe failure**

Run: `pnpm --filter @synergy/cli test -- review-analysis.test.ts`

Expected: FAIL because the parser does not exist.

- [ ] **Step 3: Implement strict structural parsing**

Use reusable `assertRecord`, `assertOnlyKeys`, `assertString`, and array validators. Narrow without `any`. Return freshly constructed values so unknown fields cannot leak through.

- [ ] **Step 4: Replace the loose CLI body parser**

`readUsageAnalysis()` parses JSON to `unknown`, calls `parseReviewAnalysisInput`, and converts validation errors to `ReviewUsageError` with the exact JSON path.

- [ ] **Step 5: Verify**

Run: `pnpm --filter @synergy/cli test -- review-analysis.test.ts review-cli.test.ts`

Run: `pnpm --filter @synergy/cli typecheck`

Expected: PASS.

- [ ] **Step 6: Root integrator commit**

`git add packages/cli/src && git commit -m "feat(review): accept strict local section keys"`

---

### Task 4: Translate local keys to durable items atomically

**Files:**
- Modify: `packages/cli/src/review-actions.ts`
- Modify: `packages/cli/src/review-actions.test.ts`
- Modify: `packages/review-core/src/scope.ts` only if a stable mapping helper is required
- Modify: `packages/review-core/tests/scope.test.ts` only if the helper is added

**Translation result:**

```ts
interface TranslatedScopeAnalysis {
  snapshot: ScopeReviewSnapshot;
  insights: ReviewInsights;
  sectionIdsByKey: ReadonlyMap<string, string>;
}
```

- [ ] **Step 1: Write failing action tests**

Given local keys, assert that:

- the CLI calls canonical `applyCodeSections` internally;
- groups contain resulting durable IDs in submitted key order;
- descriptions/confidence/evidence attach to the correct durable item;
- full coverage is checked before publication;
- a bad key/range/description leaves the revision pending and unchanged;
- predecessor reconciliation runs only after successful translation;
- diff behavior is unchanged.

- [ ] **Step 2: Run and observe failure**

Run: `pnpm --filter @synergy/cli test -- review-actions.test.ts`

Expected: FAIL because current scope input expects opaque IDs and separate insight maps.

- [ ] **Step 3: Implement the translation boundary**

For scope input:

1. assert exact coverage;
2. convert local sections to Review Core section definitions;
3. call `applyCodeSections` once;
4. pair submitted sections with resulting items by validated path/range order;
5. build a unique `key -> item.id` map;
6. build canonical insight groups/items;
7. run `assertValidAnalysis`;
8. reconcile progress;
9. call `finalizeScopeAnalysis` once.

Never persist local keys or expose durable IDs in the request schema.

- [ ] **Step 4: Verify atomicity and compatibility**

Run: `pnpm --filter @synergy/cli test -- review-actions.test.ts review-cli.test.ts`

Run: `pnpm --filter @synergy/review-core test`

Expected: PASS.

- [ ] **Step 5: Root integrator commit**

`git add packages/cli packages/review-core && git commit -m "refactor(review): derive scoped item identities internally"`

---

### Task 5: Report analysis and preview timing without coupling success

**Files:**
- Modify: `packages/cli/src/review-actions.ts`
- Modify: `packages/cli/src/review-cli.ts`
- Modify: `packages/cli/src/review-actions.test.ts`
- Modify: `packages/cli/src/review-cli.test.ts`
- Modify: `packages/review-core/src/types.ts`
- Modify: `packages/review-core/src/store.ts`
- Modify: `packages/review-core/tests/store.test.ts`

**JSON success shape:**

```ts
export interface ReviewAnalysisSetResult {
  reference: string;
  analysisFinalizedInMs: number;
  route: string;
  previewReady: boolean;
  url?: string;
}
```

- [ ] **Step 1: Write failing timing/output tests**

Inject a clock. Assert finalization duration is nonnegative, persisted timestamps survive resume, `previewReady: false` still exits successfully after analysis finalizes, and a healthy runtime adds the full URL.

- [ ] **Step 2: Run and observe failure**

Run: `pnpm --filter @synergy/cli test -- review-actions.test.ts review-cli.test.ts`

Expected: FAIL because `analysis-set` has no JSON output or preview state.

- [ ] **Step 3: Persist capture and finalization timestamps**

Use monotonic time for command durations and ISO timestamps for durable milestones. Do not infer agent analysis time from filesystem mtimes when explicit capture/finalization timestamps exist.

- [ ] **Step 4: Add `analysis-set --json` output**

Finalization determines exit success. Query preview afterward; absence or failed health sets `previewReady: false` and omits `url` without rolling back or failing analysis.

- [ ] **Step 5: Verify**

Run: `pnpm --filter @synergy/cli test`

Run: `pnpm --filter @synergy/review-core test`

Expected: PASS.

- [ ] **Step 6: Root integrator commit**

`git add packages/cli packages/review-core && git commit -m "feat(review): report review-ready timings"`

---

### Task 6: Simplify the agent workflow and prove the performance target

**Files:**
- Modify: `skills/review/SKILL.md`
- Modify: `commands/synergy-review.md`
- Modify: `packages/plugin-guard/tests/review-skill.test.ts`
- Create: `packages/cli/src/review-analysis.schema.json`
- Create: `scripts/benchmark-review-analysis.mjs`
- Create: `docs/review-performance.md`
- Modify: `.claude-plugin/plugin.json`
- Modify: generated version stamps and runtime `dist/**`

- [ ] **Step 1: Write failing skill-contract tests**

Assert the skill:

- uses the local-key scope example;
- explains repository-aware one-or-two-sentence descriptions;
- requires exact captured text coverage;
- reads guidance from create/status output;
- never imports Review Core, mentions `applyCodeSections`, emits helper JavaScript, or asks the agent to calculate durable IDs;
- uses `analysis-set --json` and the returned URL/readiness state.

- [ ] **Step 2: Run and observe failure**

Run: `pnpm --filter @synergy/plugin-guard test -- review-skill.test.ts`

Expected: FAIL against the `0.12.x` skill contract.

- [ ] **Step 3: Update schema, skill, and command**

Publish a JSON Schema with `oneOf` diff/scope, `additionalProperties: false` at every object level, and local-key references for scope. Keep the skill focused on reading captured code and writing concise purpose descriptions; deterministic identity work belongs entirely to CLI.

- [ ] **Step 4: Add a five-run benchmark harness**

The script accepts a fixture/root and invokes the normal warm review flow five times. Emit JSON containing each run's capture, agent-analysis interval supplied by fixture replay, publication, preview readiness, and total. Fail when median exceeds 210 seconds or any run exceeds 240 seconds. Do not fake live model latency; the replay fixture measures deterministic tool overhead separately and dogfood records the real end-to-end interval.

- [ ] **Step 5: Dogfood the representative scope**

Use approximately 15 TypeScript files and 3,000 lines. Record five warm end-to-end runs in `docs/review-performance.md`, including environment, revision, unit count, median, maximum, and phase breakdown. Target about 20–30 units; a count outside guidance requires a written reason.

- [ ] **Step 6: Bump and synchronize `0.13.0`**

Update `.claude-plugin/plugin.json`, run version sync, rebuild tracked runtime artifacts, and verify zero drift.

- [ ] **Step 7: Run full verification**

Run: `pnpm typecheck`

Run: `pnpm lint`

Run: `pnpm test`

Run: `pnpm build`

Run: `pnpm check:artifacts`

Run: `pnpm exec tsx packages/plugin-guard/src/version-sync.ts --check`

Expected: PASS. Re-run and document the one known feedback-stream watcher flake if it appears; do not skip it.

- [ ] **Step 8: Root integrator logic review**

Confirm exact text coverage, one translation call, no local keys persisted, no durable IDs requested from agents, no partial finalization, diff compatibility, and preview-independent analysis success.

- [ ] **Step 9: Root integrator commit, push, and PR**

`git add . && git commit -m "feat(review): streamline scoped analysis"`

Push the PR2 branch after PR1 lands, and open a PR titled `feat(review): streamline scoped analysis` with five-run evidence and explicit linkage to issue #22 for deferred AST/parallel work.
