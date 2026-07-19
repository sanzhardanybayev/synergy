# Synergy Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a durable, Vite-rendered Synergy workflow for guided PR, staged, unstaged, and scoped codebase reviews with repository-aware item descriptions and browser-to-agent questions.

**Architecture:** A new `@synergy/review-core` package owns review contracts, snapshots, fingerprints, persistence, reconciliation, readiness, and the durable question queue. The existing CLI captures sources and exposes review commands; the existing preview daemon serves `/r/...` routes and review APIs; a shared skill performs repository-aware analysis and the foreground answer loop.

**Tech Stack:** TypeScript 5.6, Node.js 20+, pnpm workspaces, Vite 5, React 18, React Router 6, Vitest, React Testing Library, Ajv, Git, GitHub CLI.

## Global Constraints

- Review is separate from `.synergy/sessions/`, phases, and execution state.
- Review artifacts live under gitignored `.synergy/reviews/`; `.synergy/active-review.json` is also gitignored.
- Review data is JSON, not MDX; the shareable export is Markdown.
- Reuse the existing Ember & Graphite `--syn-*` tokens; add no independent palette or hardcoded review colors.
- A review item is a diff hunk for change reviews and a meaningful code section for scoped reviews.
- Descriptions are one or two concise repository-aware sentences, not line-by-line syntax paraphrases.
- Git inclusion follows standard semantics: exact PR/index diffs; tracked plus non-ignored untracked files for unstaged/scope/context.
- Historical snapshots are immutable. Changed or ambiguously mapped items need re-review; unchanged items carry forward by reference.
- Browser success is reported only after durable atomic persistence.
- No Vouch integration, standalone HTML, history UI, change-story map, context-peek system, or automatic code mutation.
- Do not commit or push. The repository requires separate explicit approval for both actions.

---

## File map

### New package: `packages/review-core`

- `package.json`, `tsconfig.json`, `tsup.config.ts`: workspace package and build configuration.
- `src/types.ts`: all persisted and public review contracts.
- `src/schema.ts`: Ajv schemas and assertion helpers.
- `src/hash.ts`: canonical text/JSON hashing.
- `src/ids.ts`: safe workspace/revision/reference parsing.
- `src/atomic.ts`: atomic JSON persistence primitive.
- `src/paths.ts`: traversal-safe review artifact paths.
- `src/store.ts`: workspace, revision, insight, progress, and active-review storage.
- `src/diff.ts`: unified-diff parser and hunk snapshot builder.
- `src/scope.ts`: scoped-file snapshot and code-section validation.
- `src/reconcile.ts`: granular carry-forward and stale mapping.
- `src/readiness.ts`: derived completion state.
- `src/questions.ts`: durable question, claim lease, answer, and listener presence operations.
- `src/index.ts`: package exports.
- `tests/*.test.ts`: focused tests for every module above.

### Existing CLI: `packages/cli`

- `src/review-capture.ts`: Git/GitHub capture adapters and eligible scope manifest.
- `src/review-actions.ts`: create, refresh, analysis-set, list, open, and status use cases.
- `src/review-wait.ts`: foreground wait and heartbeat wrapper around review-core queue operations.
- `src/review-cli.ts`: CAC command registration and output contracts.
- `src/cli.ts`: register the review command family.
- `src/paths.ts`: expose `reviewsDir` and `activeReviewFile`.
- `src/init.ts`: gitignore review artifacts.
- Tests beside the new CLI modules.

### Existing preview: `packages/preview`

- `vite-plugin-edit.ts`: delegate `/api/reviews/*` to a focused router.
- `src/server/review-router.ts`: route matching and path validation.
- `src/server/review-api.ts`: load review, mutate progress, queue questions, and set active review.
- `src/server/review-stream.ts`: SSE for questions, answers, progress, source freshness, and listener presence.
- `src/review/ReviewRoute.tsx`: route loading and unknown/error states.
- `src/review/ReviewProvider.tsx`: client review state and durable mutations.
- `src/review/ReviewShell.tsx`: three-column review layout.
- `src/review/ReviewHeader.tsx`, `ReviewSidebar.tsx`, `ReviewStage.tsx`, `ReviewItemPanel.tsx`, `QuestionRail.tsx`: focused UI surfaces.
- `src/review/DiffViewer.tsx`, `SourceViewer.tsx`: selectable-line renderers.
- `src/review/review.css`: review layout using only `--syn-*` tokens.
- `src/api.ts`: typed review API client.
- `src/App.tsx`, `src/main.tsx`: `/r/:workspaceId/:revisionId` route and review CSS import.
- Tests for server handlers, state, rendering, accessibility, and readiness.

### Skill and documentation

- `skills/review/SKILL.md`: cross-host creation, analysis, resume, answer, and wait workflow.
- `commands/synergy-review.md`: Claude Code entry point.
- `.claude-plugin/plugin.json`: feature version bump.
- `README.md`, `AGENTS.md`, `CLAUDE.md`: review usage and invariants.
- `docs/superpowers/specs/2026-07-19-synergy-review-design.md`: approved design.

---

### Task 1: Review contracts, schemas, IDs, and storage

**Files:**
- Create: `packages/review-core/package.json`
- Create: `packages/review-core/tsconfig.json`
- Create: `packages/review-core/tsup.config.ts`
- Create: `packages/review-core/src/types.ts`
- Create: `packages/review-core/src/schema.ts`
- Create: `packages/review-core/src/hash.ts`
- Create: `packages/review-core/src/ids.ts`
- Create: `packages/review-core/src/atomic.ts`
- Create: `packages/review-core/src/paths.ts`
- Create: `packages/review-core/src/store.ts`
- Create: `packages/review-core/src/index.ts`
- Create: `packages/review-core/tests/ids.test.ts`
- Create: `packages/review-core/tests/store.test.ts`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Produces: `ReviewWorkspace`, `ReviewSnapshot`, `ReviewItem`, `ReviewInsights`, `ReviewProgress`, `ReviewQuestion`, `ReviewAnswer`, and `ReviewBundle`.
- Produces: `formatReviewRef(workspaceId, revisionId)`, `parseReviewRef(value)`, `createReviewStore(projectRoot)`, `hashText(text)`, and schema assertion helpers.

- [ ] **Step 1: Write failing ID and storage tests**

```ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createReviewStore, formatReviewRef, parseReviewRef } from '../src/index.js';

describe('review references', () => {
  it('round-trips a safe workspace and revision', () => {
    const value = formatReviewRef('mobile-app-pr-317', 'abc1234-def5678');
    expect(parseReviewRef(value)).toEqual({
      workspaceId: 'mobile-app-pr-317',
      revisionId: 'abc1234-def5678',
    });
  });

  it('rejects traversal', () => {
    expect(() => parseReviewRef('../outside@abc')).toThrow('invalid review workspace');
  });
});

it('creates an immutable revision and reads it as a bundle', () => {
  const root = mkdtempSync(join(tmpdir(), 'synergy-review-'));
  const store = createReviewStore(root);
  const fixture = makeReviewFixture();
  store.createRevision(fixture.workspace, fixture.snapshot, fixture.insights, fixture.progress);
  expect(store.readBundle('mobile-app-staged', 'patch-a82c19f')).toEqual(fixture.bundle);
  expect(() =>
    store.createRevision(fixture.workspace, fixture.snapshot, fixture.insights, fixture.progress),
  ).toThrow('revision already exists');
});
```

- [ ] **Step 2: Run the tests and confirm the package does not exist**

Run: `pnpm --filter @synergy/review-core test`

Expected: failure because `@synergy/review-core` and its exports do not exist.

- [ ] **Step 3: Add the package and strict domain contracts**

Define discriminated sources and persisted state in `src/types.ts`:

```ts
export type ReviewSource =
  | { kind: 'pr'; number: number; url: string; baseSha: string; headSha: string }
  | { kind: 'staged'; headSha: string }
  | { kind: 'unstaged'; headSha: string }
  | { kind: 'scope'; patterns: string[]; headSha: string };

export type ReviewItemKind = 'hunk' | 'code-section';
export type ReviewItemStatus = 'needs-review' | 'reviewed' | 'carried-forward' | 'stale';

export interface ReviewItem {
  id: string;
  kind: ReviewItemKind;
  path: string;
  label: string;
  range: { start: number; end: number };
  contentHash: string;
  locationHash: string;
}

export interface ReviewItemProgress {
  status: ReviewItemStatus;
  note?: string;
  reviewedAt?: string;
  inheritedFrom?: { revisionId: string; reviewItemId: string };
}

export interface ReviewProgress {
  schemaVersion: 1;
  updatedAt: string;
  items: Record<string, ReviewItemProgress>;
  activeGroupId?: string;
  activeFile?: string;
  activeReviewItemId?: string;
}
```

Add complete persisted interfaces for workspace, snapshot unions, diff/source lines, insights, groups, questions, answers, claims, and the aggregate bundle. Use Ajv to assert every file before returning it from storage.

- [ ] **Step 4: Implement safe references and atomic persistence**

```ts
const SAFE_SEGMENT = /^[a-z0-9][a-z0-9._-]*$/;

export function parseReviewRef(value: string): ReviewRef {
  const separator = value.lastIndexOf('@');
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error('review reference must be <workspace>@<revision>');
  }
  const workspaceId = value.slice(0, separator);
  const revisionId = value.slice(separator + 1);
  if (!SAFE_SEGMENT.test(workspaceId)) throw new Error('invalid review workspace');
  if (!SAFE_SEGMENT.test(revisionId)) throw new Error('invalid review revision');
  return { workspaceId, revisionId };
}

export function atomicWriteJson(path: string, value: unknown): void {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(temporary, path);
}
```

`createReviewStore()` must resolve every artifact beneath `<root>/.synergy/reviews`, validate reads, refuse overwriting immutable snapshot/insight files, and merge only mutable progress through `updateProgress()`.

- [ ] **Step 5: Install and run focused tests**

Run: `pnpm install`

Run: `pnpm --filter @synergy/review-core test`

Expected: all ID, traversal, schema, atomic-write, immutable-revision, and bundle-read tests pass.

- [ ] **Step 6: Run package typecheck and build**

Run: `pnpm --filter @synergy/review-core typecheck && pnpm --filter @synergy/review-core build`

Expected: both commands exit 0 and `packages/review-core/dist/index.js` plus declarations exist.

### Task 2: Diff parsing and scoped snapshot validation

**Files:**
- Create: `packages/review-core/src/diff.ts`
- Create: `packages/review-core/src/scope.ts`
- Create: `packages/review-core/tests/diff.test.ts`
- Create: `packages/review-core/tests/scope.test.ts`
- Modify: `packages/review-core/src/index.ts`

**Interfaces:**
- Consumes: Task 1 contracts and `hashText()`.
- Produces: `parseUnifiedDiff(patch)`, `buildDiffSnapshot(input)`, `buildScopeSnapshot(input)`, and `applyCodeSections(snapshot, sections)`.

- [ ] **Step 1: Write failing unified-diff tests**

```ts
it('parses multiple hunks with stable line identities', () => {
  const files = parseUnifiedDiff(FIXTURE_PATCH);
  expect(files[0]).toMatchObject({
    path: 'src/add.ts',
    status: 'modified',
    additions: 2,
    deletions: 1,
  });
  expect(files[0]?.hunks).toHaveLength(2);
  expect(files[0]?.hunks[0]?.lines[1]).toMatchObject({
    kind: 'remove',
    oldLine: 4,
    newLine: null,
  });
});

it('preserves rename and binary metadata without inventing text items', () => {
  const files = parseUnifiedDiff(RENAME_AND_BINARY_PATCH);
  expect(files[0]?.previousPath).toBe('src/old.ts');
  expect(files[1]?.binary).toBe(true);
  expect(files[1]?.hunks).toEqual([]);
});
```

- [ ] **Step 2: Run focused tests and confirm missing exports**

Run: `pnpm --filter @synergy/review-core test -- diff.test.ts scope.test.ts`

Expected: failure because parser and scope builders do not exist.

- [ ] **Step 3: Implement the parser as a line-state machine**

`parseUnifiedDiff()` must parse `diff --git`, old/new paths, added/deleted/renamed/binary status, hunk headers, context/add/remove lines, and `\ No newline at end of file`. Generate each hunk item from normalized diff content plus path/context, never from absolute line numbers alone.

```ts
export function createHunkReviewItem(path: string, hunk: DiffHunk): ReviewItem {
  const selected = hunk.lines
    .filter((line) => line.kind !== 'context')
    .map((line) => `${line.kind}:${line.text}`)
    .join('\n');
  const context = hunk.lines.map((line) => `${line.kind}:${line.text}`).join('\n');
  return {
    id: `hunk-${hashText(`${path}\n${context}`).slice(0, 16)}`,
    kind: 'hunk',
    path,
    label: hunk.header,
    range: { start: hunk.newStart, end: hunk.newStart + Math.max(hunk.newLines - 1, 0) },
    contentHash: hashText(selected),
    locationHash: hashText(`${path}\n${context}`),
  };
}
```

- [ ] **Step 4: Implement scoped snapshots and validated code sections**

```ts
export interface ProposedCodeSection {
  path: string;
  label: string;
  start: number;
  end: number;
  parentLabel?: string;
}

export function applyCodeSections(
  snapshot: ScopeReviewSnapshot,
  proposed: ProposedCodeSection[],
): ScopeReviewSnapshot {
  const items = proposed.map((section) => validateAndBuildSection(snapshot, section));
  return { ...snapshot, items };
}
```

Validation must reject missing paths, ranges outside file bounds, overlapping duplicate sections, and empty selections. The content hash covers exact section text. The location hash covers repository-relative path, label, parent label, and bounded surrounding context, but excludes absolute line numbers so unrelated insertions above can carry forward.

- [ ] **Step 5: Run focused and package tests**

Run: `pnpm --filter @synergy/review-core test -- diff.test.ts scope.test.ts`

Expected: parser and scope tests pass, including traversal, CRLF normalization, binary files, renamed files, line shifts, and invalid section ranges.

### Task 3: Reconciliation and readiness

**Files:**
- Create: `packages/review-core/src/reconcile.ts`
- Create: `packages/review-core/src/readiness.ts`
- Create: `packages/review-core/tests/reconcile.test.ts`
- Create: `packages/review-core/tests/readiness.test.ts`
- Modify: `packages/review-core/src/index.ts`

**Interfaces:**
- Consumes: `ReviewBundle`, `ReviewItem`, and `ReviewProgress`.
- Produces: `reconcileReview(previous, currentSnapshot, now)` and `deriveReviewReadiness(bundle)`.

- [ ] **Step 1: Write the reconciliation decision-table tests**

```ts
it('carries reviewed content only when content and location are unique matches', () => {
  const result = reconcileReview(previousBundle, shiftedButUnchangedSnapshot, NOW);
  expect(result.items['hunk-current']).toEqual({
    status: 'carried-forward',
    inheritedFrom: { revisionId: 'old-revision', reviewItemId: 'hunk-old' },
    reviewedAt: NOW,
  });
});

it.each([
  ['content changed', changedContentSnapshot],
  ['semantic location changed', changedLocationSnapshot],
  ['duplicate candidates', duplicateCandidateSnapshot],
])('does not carry coverage when %s', (_name, snapshot) => {
  const result = reconcileReview(previousBundle, snapshot, NOW);
  expect(Object.values(result.items).some((item) => item.status === 'carried-forward')).toBe(false);
});
```

- [ ] **Step 2: Run tests and verify failure**

Run: `pnpm --filter @synergy/review-core test -- reconcile.test.ts readiness.test.ts`

Expected: failure because reconciliation/readiness functions are missing.

- [ ] **Step 3: Implement unique composite matching**

Index prior reviewed/carried items by `path + kind + contentHash + locationHash`. Carry only when both sides have exactly one candidate. Exact current IDs retain explicit review state. New items become `needs-review`; conflicting candidates become `stale`; removed items remain only in the old immutable revision.

```ts
export function reconciliationKey(item: ReviewItem): string {
  return [item.path, item.kind, item.contentHash, item.locationHash].join(':');
}
```

- [ ] **Step 4: Implement derived readiness**

```ts
export function deriveReviewReadiness(bundle: ReviewBundle): ReviewReadiness {
  const states = bundle.snapshot.items.map((item) => bundle.progress.items[item.id]);
  const pending = states.filter((state) => !state || state.status === 'needs-review').length;
  const stale = states.filter((state) => state?.status === 'stale').length;
  const unanswered = bundle.questions.filter((question) => question.status !== 'answered').length;
  return {
    ready: pending === 0 && stale === 0 && unanswered === 0 && !bundle.sourceChanged,
    pending,
    stale,
    unanswered,
    sourceChanged: bundle.sourceChanged,
  };
}
```

- [ ] **Step 5: Run tests and package gates**

Run: `pnpm --filter @synergy/review-core test && pnpm --filter @synergy/review-core typecheck`

Expected: all review-core tests pass and typecheck exits 0.

### Task 4: Git/GitHub capture and review lifecycle CLI

**Files:**
- Create: `packages/cli/src/review-capture.ts`
- Create: `packages/cli/src/review-actions.ts`
- Create: `packages/cli/src/review-cli.ts`
- Create: `packages/cli/src/review-capture.test.ts`
- Create: `packages/cli/src/review-actions.test.ts`
- Modify: `packages/cli/package.json`
- Modify: `packages/cli/src/cli.ts`
- Modify: `packages/cli/src/paths.ts`

**Interfaces:**
- Consumes: review-core store, snapshot builders, reconciliation, and readiness.
- Produces: `captureReviewSource(request)`, `createOrResumeReview(request)`, `refreshReview(workspaceId)`, `applyReviewAnalysis(ref, analysis)`, `printReviewStatus(ref)`, and `registerReviewCommands(cli)`.

- [ ] **Step 1: Write failing capture tests using an injected command runner**

```ts
it('captures unstaged tracked and non-ignored untracked files', () => {
  const runner = createFixtureRunner({
    'git diff --no-ext-diff --binary': TRACKED_PATCH,
    'git ls-files --others --exclude-standard -z': 'src/new.ts\0',
    'git show HEAD:src/new.ts': { exitCode: 128, stdout: '' },
  });
  const result = captureUnstaged({ root: '/repo', runner, readFile: () => 'export const x = 1;\n' });
  expect(result.patch).toContain('src/new.ts');
  expect(result.eligiblePaths).toContain('src/new.ts');
  expect(result.eligiblePaths).not.toContain('node_modules/pkg/index.js');
});
```

- [ ] **Step 2: Run focused CLI tests and verify failure**

Run: `pnpm --filter @synergy/cli test -- review-capture.test.ts review-actions.test.ts`

Expected: failure because review capture/actions are missing.

- [ ] **Step 3: Implement capture adapters**

Use `execFileSync` through an injected `CommandRunner` so tests never call real GitHub. Implement:

- PR: `gh pr view --json number,title,url,baseRefOid,headRefOid` plus `gh pr diff --patch`.
- Staged: `git diff --cached --no-ext-diff --binary`.
- Unstaged: tracked diff plus synthetic added-file patches for `git ls-files --others --exclude-standard -z`.
- Scope/context: `git ls-files --cached --others --exclude-standard -z -- <patterns>` followed by safe text reads.

Return actionable errors for missing Git, missing `gh`, unauthenticated PR access, empty changes, invalid paths, and binary-only scope.

- [ ] **Step 4: Implement idempotent create/refresh and analysis application**

```ts
export interface CreateReviewResult {
  reference: ReviewRef;
  resumed: boolean;
  url: string;
  analysisRequired: boolean;
}

export function createOrResumeReview(request: CreateReviewRequest): CreateReviewResult {
  const captured = captureReviewSource(request);
  const identity = createReviewIdentity(captured);
  const store = createReviewStore(request.root);
  const existing = store.findRevisionByFingerprint(identity.workspaceId, captured.fingerprint);
  if (existing) return resultFor(existing, true);
  return createNewRevision(store, identity, captured);
}
```

`applyReviewAnalysis()` validates group IDs, review-item IDs, code-section ranges, description length/confidence, and evidence paths before writing immutable `insights.json`. It refuses unknown or duplicate items.

- [ ] **Step 5: Register the CAC command family**

```text
synergy review create --pr <number-or-url>
synergy review create --staged
synergy review create --unstaged
synergy review create --scope <path>
synergy review refresh <workspace>
synergy review analysis-set <reference> --body-file <path>
synergy review list
synergy review open <reference>
synergy review status <reference>
```

Exactly one create source flag is required. Machine-facing create/status output supports `--json`; human output prints the reference, whether it resumed, preparation state, and URL.

- [ ] **Step 6: Run CLI tests, typecheck, and build**

Run: `pnpm --filter @synergy/cli test -- review-capture.test.ts review-actions.test.ts`

Run: `pnpm --filter @synergy/cli typecheck && pnpm --filter @synergy/cli build`

Expected: commands pass fixtures, invalid combinations exit 2, and CLI build resolves `@synergy/review-core`.

### Task 5: Durable question queue, claims, answers, and foreground wait

**Files:**
- Create: `packages/review-core/src/questions.ts`
- Create: `packages/review-core/tests/questions.test.ts`
- Modify: `packages/review-core/src/index.ts`
- Create: `packages/cli/src/review-wait.ts`
- Create: `packages/cli/src/review-wait.test.ts`
- Modify: `packages/cli/src/review-cli.ts`

**Interfaces:**
- Produces: `enqueueQuestion`, `listQuestions`, `claimQuestions`, `renewClaim`, `releaseClaim`, `writeAnswer`, `touchReviewListener`, `waitForReviewQuestions`.
- Adds CLI actions: `synergy review wait <ref> [--for 15m]` and `synergy review answer <questionId> --review <ref> --body-file <path>`.

- [ ] **Step 1: Write failing queue and lease tests**

```ts
it('allows only one active claim and requeues it after lease expiry', () => {
  const queue = createQuestionQueue(tempRoot, REVIEW_REF);
  const question = queue.enqueue(makeQuestion());
  expect(queue.claim(question.id, 'agent-a', now, 60_000).ok).toBe(true);
  expect(queue.claim(question.id, 'agent-b', now + 1, 60_000).ok).toBe(false);
  expect(queue.claim(question.id, 'agent-b', now + 60_001, 60_000).ok).toBe(true);
});

it('persists an answer before marking the question answered', () => {
  const answer = queue.answer(question.id, 'agent-a', 'The hook synchronizes access state.', now);
  expect(queue.readAnswer(answer.id)?.body).toContain('synchronizes access state');
  expect(queue.readQuestion(question.id)?.status).toBe('answered');
});
```

- [ ] **Step 2: Run queue tests and verify failure**

Run: `pnpm --filter @synergy/review-core test -- questions.test.ts`

Expected: failure because the queue module is missing.

- [ ] **Step 3: Implement durable files and exclusive claims**

Persist one JSON file per question and answer. Acquire `<questions>/<id>.claim` with exclusive creation (`openSync(path, 'wx')`). The claim records `listenerId`, `claimedAt`, and `expiresAt`. On expiry, remove it before retrying. Write the answer first, then atomically update the question to `answered`.

- [ ] **Step 4: Implement wait with file watching and heartbeat cleanup**

Mirror the proven `feedback-wait.ts` contract: scan queued questions before attaching `fs.watch`, debounce events, re-scan after watcher attachment, touch listener presence every 30 seconds, remove presence on resolution/signal, and emit structured JSON only on stdout.

```ts
export interface ReviewWaitResult {
  status: 'questions' | 'timeout';
  listenerId: string;
  questions: ReviewQuestion[];
}
```

- [ ] **Step 5: Register wait/answer and run tests**

Run: `pnpm --filter @synergy/review-core test -- questions.test.ts`

Run: `pnpm --filter @synergy/cli test -- review-wait.test.ts`

Expected: queued questions return immediately, timeouts clean presence, signals release claims, and answers are durable.

### Task 6: Preview review API and SSE

**Files:**
- Create: `packages/preview/src/server/review-router.ts`
- Create: `packages/preview/src/server/review-api.ts`
- Create: `packages/preview/src/server/review-stream.ts`
- Create: `packages/preview/tests/server/review-router.test.ts`
- Create: `packages/preview/tests/server/review-api.test.ts`
- Create: `packages/preview/tests/server/review-stream.test.ts`
- Modify: `packages/preview/package.json`
- Modify: `packages/preview/vite-plugin-edit.ts`

**Interfaces:**
- Consumes: review-core stores, progress/readiness, and question queue.
- Produces routes under `/api/reviews` for bundle reads, progress mutation, question enqueue, active-review ping, and SSE.

- [ ] **Step 1: Write failing handler tests**

```ts
it('persists review progress before returning success', async () => {
  const response = await callReviewApi('PATCH', `/api/reviews/${WORKSPACE}/${REVISION}/progress`, {
    reviewItemId: 'hunk-a',
    status: 'reviewed',
  });
  expect(response.status).toBe(200);
  expect(store.readProgress(WORKSPACE, REVISION).items['hunk-a']?.status).toBe('reviewed');
});

it('queues a selected-line question against the exact revision', async () => {
  const response = await callReviewApi('POST', `/api/reviews/${WORKSPACE}/${REVISION}/questions`, {
    reviewItemId: 'hunk-a',
    selectedLineIds: ['line-2'],
    body: 'Why is this safe on Android?',
  });
  expect(response.status).toBe(201);
  expect(response.json.question.revisionId).toBe(REVISION);
});
```

- [ ] **Step 2: Run server tests and verify failure**

Run: `pnpm --filter @synergy/preview test -- review-api.test.ts review-stream.test.ts`

Expected: failure because review handlers are absent.

- [ ] **Step 3: Implement route matching and mutations**

Support:

```text
GET   /api/reviews/:workspace/:revision
PATCH /api/reviews/:workspace/:revision/progress
POST  /api/reviews/:workspace/:revision/questions
POST  /api/reviews/:workspace/:revision/active
GET   /api/reviews/:workspace/:revision/stream
```

Validate segments with review-core reference parsing. Progress only accepts known item IDs and `reviewed`/`needs-review` transitions plus notes. Question creation resolves selected line IDs from the immutable snapshot; clients cannot inject arbitrary source text.

- [ ] **Step 4: Implement SSE frames**

Emit typed frames:

```ts
export type ReviewStreamFrame =
  | { type: 'presence'; listening: boolean }
  | { type: 'question'; question: ReviewQuestion }
  | { type: 'answer'; answer: ReviewAnswer }
  | { type: 'progress'; progress: ReviewProgress; readiness: ReviewReadiness }
  | { type: 'source'; changed: boolean };
```

Watch only the target revision directories, debounce filesystem bursts, send an initial presence/progress frame, use SSE keep-alives, and close watchers on request close.

- [ ] **Step 5: Delegate from the existing Vite middleware and run tests**

Add one early `/api/reviews` delegation in `vite-plugin-edit.ts`; keep review route details out of the existing middleware file.

Run: `pnpm --filter @synergy/preview test -- review-router.test.ts review-api.test.ts review-stream.test.ts`

Expected: all API, traversal, atomic mutation, selected-line validation, SSE cleanup, and presence tests pass.

### Task 7: Typed preview client and review state provider

**Files:**
- Create: `packages/preview/src/review/ReviewProvider.tsx`
- Create: `packages/preview/tests/ReviewProvider.test.tsx`
- Modify: `packages/preview/src/api.ts`

**Interfaces:**
- Consumes: Task 6 endpoints and review-core public types.
- Produces: `useReview()` with bundle, selected lines, active item, progress mutation, notes, question enqueue, stream status, and readiness.

- [ ] **Step 1: Write failing provider tests**

```tsx
it('updates a checkbox only after the progress request succeeds', async () => {
  render(<ReviewProvider reference={REFERENCE}><Probe /></ReviewProvider>);
  await user.click(await screen.findByRole('button', { name: 'Mark reviewed' }));
  expect(patchProgress).toHaveBeenCalledWith(REFERENCE, 'hunk-a', 'reviewed');
  expect(await screen.findByText('1 of 2 reviewed')).toBeVisible();
});

it('keeps a failed question draft and reports the error', async () => {
  postQuestion.mockRejectedValueOnce(new Error('disk full'));
  render(<ReviewProvider reference={REFERENCE}><QuestionProbe /></ReviewProvider>);
  await user.type(screen.getByRole('textbox'), 'Explain this');
  await user.click(screen.getByRole('button', { name: 'Send question' }));
  expect(screen.getByRole('textbox')).toHaveValue('Explain this');
  expect(await screen.findByText('Could not queue question: disk full')).toBeVisible();
});
```

- [ ] **Step 2: Run the provider test and verify failure**

Run: `pnpm --filter @synergy/preview test -- ReviewProvider.test.tsx`

Expected: failure because the provider and review API functions are absent.

- [ ] **Step 3: Add typed review API functions**

Add `getReviewBundle`, `patchReviewProgress`, `postReviewQuestion`, `postActiveReview`, and `openReviewStream`. Every non-2xx response throws a descriptive error; progress/question success returns validated review-core data.

- [ ] **Step 4: Implement provider state and SSE reconciliation**

Keep server persistence authoritative. Optimistically mark only transient `saving` state; apply progress and queued-question changes from successful responses or stream frames. Preserve drafts on failures. Clear selected lines when active item changes.

- [ ] **Step 5: Run provider and API tests**

Run: `pnpm --filter @synergy/preview test -- ReviewProvider.test.tsx`

Expected: durable-success, failure-preservation, stream update, and cleanup tests pass.

### Task 8: Review routes and three-column UI

**Files:**
- Create: `packages/preview/src/review/ReviewRoute.tsx`
- Create: `packages/preview/src/review/ReviewShell.tsx`
- Create: `packages/preview/src/review/ReviewHeader.tsx`
- Create: `packages/preview/src/review/ReviewSidebar.tsx`
- Create: `packages/preview/src/review/ReviewStage.tsx`
- Create: `packages/preview/src/review/ReviewItemPanel.tsx`
- Create: `packages/preview/src/review/DiffViewer.tsx`
- Create: `packages/preview/src/review/SourceViewer.tsx`
- Create: `packages/preview/src/review/QuestionRail.tsx`
- Create: `packages/preview/src/review/review.css`
- Create: `packages/preview/tests/ReviewRoute.test.tsx`
- Create: `packages/preview/tests/ReviewShell.test.tsx`
- Create: `packages/preview/tests/QuestionRail.test.tsx`
- Modify: `packages/preview/src/App.tsx`
- Modify: `packages/preview/src/main.tsx`

**Interfaces:**
- Consumes: `ReviewProvider` and review-core item/snapshot types.
- Produces: `/r/:workspaceId/:revisionId` interactive review portal.

- [ ] **Step 1: Write failing route and interaction tests**

```tsx
it('renders groups, files, the active hunk, and its repository-aware description', async () => {
  renderReviewRoute(diffBundle);
  expect(await screen.findByText('Theme and surfaces')).toBeVisible();
  expect(screen.getByText('features/plan/PlanCardToggle.tsx')).toBeVisible();
  expect(screen.getByText(/uses the nutrition-plan surface token/)).toBeVisible();
  expect(screen.getByRole('button', { name: 'Mark reviewed' })).toBeEnabled();
});

it('selects diff lines and sends them with a question', async () => {
  renderReviewRoute(diffBundle);
  await user.click(screen.getByRole('button', { name: 'Select new line 18' }));
  await user.type(screen.getByRole('textbox', { name: 'Question' }), 'Why this token?');
  await user.click(screen.getByRole('button', { name: 'Send question' }));
  expect(postQuestion).toHaveBeenCalledWith(expect.objectContaining({ selectedLineIds: ['line-18'] }));
});
```

- [ ] **Step 2: Run UI tests and verify failure**

Run: `pnpm --filter @synergy/preview test -- ReviewRoute.test.tsx ReviewShell.test.tsx QuestionRail.test.tsx`

Expected: failure because the route and components are missing.

- [ ] **Step 3: Add the route and loading/error states**

Register `/r/:workspaceId/:revisionId` before the session route. `ReviewRoute` validates params, loads the bundle, pings active review on focus, and renders explicit unknown/corrupt/unavailable states.

- [ ] **Step 4: Implement the diff and source review stages**

- `DiffViewer` renders old/new line numbers, add/remove/context markers, and line-selection buttons.
- `SourceViewer` renders the complete selected code section plus surrounding source and selectable lines.
- `ReviewItemPanel` shows only the concise description, confidence warning when low, note, and reviewed control.
- `ReviewSidebar` presents groups/files/items and progress without phase terminology.
- `QuestionRail` shows durable question states, answers, agent presence, and readiness.

- [ ] **Step 5: Add token-only responsive styling**

Import `review.css` after `app.css`. Use existing `--syn-bg*`, `--syn-fg*`, `--syn-border*`, `--syn-accent*`, `--syn-diff-*`, spacing, radii, fonts, shadows, and motion tokens. Add no hex, rgb, or rgba values. Preserve visible focus, reduced motion, horizontal code scrolling, and a usable single-column layout below 900px.

- [ ] **Step 6: Implement keyboard behavior and readiness feedback**

`J/K` navigate review items, `R` toggles review, and `?` focuses the question composer unless an input is already active. The header shows current source/revision/freshness/progress. The readiness card lists only concrete blockers: pending items, stale items, unanswered questions, or changed source.

- [ ] **Step 7: Run UI tests and inspect token use**

Run: `pnpm --filter @synergy/preview test -- ReviewRoute.test.tsx ReviewShell.test.tsx QuestionRail.test.tsx`

Run: `rg -n '#[0-9a-fA-F]{3,8}|rgba?\(' packages/preview/src/review`

Expected: tests pass and the token scan prints no matches.

### Task 9: Cross-host review skill and repository-aware analysis

**Files:**
- Create: `skills/review/SKILL.md`
- Create: `commands/synergy-review.md`
- Create: `skills/review/templates/analysis-schema.json`
- Create: `skills/review/templates/question-answer.md`
- Modify: `.claude-plugin/plugin.json`
- Modify: `packages/cli/src/init.ts`
- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: CLI create/refresh/analysis-set/open/status/wait/answer commands.
- Produces: one shared agent workflow for Claude Code and Codex.

- [ ] **Step 1: Add skill contract tests or guard fixtures**

Extend plugin-guard tests to assert the review skill has frontmatter, a freshness stamp, exact CLI command names, the repository-aware description contract, and the foreground wait requirement.

- [ ] **Step 2: Write the skill with deterministic/agent boundaries**

The skill must:

1. Resolve create/resume intent.
2. Run CLI capture and consume JSON output.
3. For PR context, inspect the captured head through Git object commands; for staged files, inspect index blobs; for unstaged/scope, inspect eligible worktree files.
4. Batch related files, search imports/exports/callers/types/tests/configuration, and create groups plus one/two-sentence descriptions.
5. For scoped reviews, propose bounded code sections and submit them through schema-validated `analysis-set`.
6. Start/open the preview.
7. Process queued questions from `review wait`, answer against the exact revision plus repository context, persist through `review answer`, and wait again.
8. Surface low confidence and stale source instead of inventing behavior.

The skill must never hand-write review JSON, detach the wait process, analyze Gitignored untracked files, or mutate application code merely because a review question was asked.

- [ ] **Step 3: Add the thin Claude command**

`commands/synergy-review.md` passes `$ARGUMENTS` to `synergy:review` and documents PR/staged/unstaged/scope/resume examples. Do not duplicate skill logic.

- [ ] **Step 4: Update initialization and product docs**

Add `reviews/` and `active-review.json` to `GITIGNORE_ENTRIES`. Document review routes, sources, artifacts, reconciliation, question loop, and the distinction from specification sessions.

- [ ] **Step 5: Bump and synchronize plugin version**

Change `.claude-plugin/plugin.json` from `0.11.0` to `0.12.0`, then run:

`pnpm exec tsx packages/plugin-guard/src/version-sync.ts`

Expected: marketplace/version stamps update to `0.12.0`, including the new review skill.

- [ ] **Step 6: Run plugin guard and docs checks**

Run: `pnpm --filter @synergy/plugin-guard test`

Run: `pnpm exec tsx packages/plugin-guard/src/version-sync.ts --check`

Expected: tests pass and version-sync reports no drift.

### Task 10: Integrated review workflows and regression gates

**Files:**
- Create: `packages/cli/src/review-e2e.test.ts`
- Create: `packages/preview/tests/review-workflow.test.tsx`
- Modify: files identified by failing integration/type/lint tests only when required by this feature.

**Interfaces:**
- Consumes: all previous tasks.
- Produces: verified end-to-end local review workflows.

- [ ] **Step 1: Add staged-review end-to-end test**

Create a temporary Git repository, stage a two-hunk change, run create, apply validated insights, mark both hunks reviewed through the store/API, enqueue and answer a selected-line question, and assert readiness becomes true.

- [ ] **Step 2: Add revision reconciliation end-to-end test**

Change only one previously reviewed hunk, refresh the workspace, and assert the unchanged item is `carried-forward`, the changed item is `needs-review`, and readiness is false.

- [ ] **Step 3: Add scoped-review and ignore end-to-end test**

Create tracked subscription files plus ignored `node_modules` and build output, create a scope snapshot, apply code sections, and assert only eligible files/items appear in the bundle and UI.

- [ ] **Step 4: Add fresh-agent reconnect test**

Queue a question, dispose the first waiter, create a second listener, claim and answer the persisted question, and assert the preview stream receives the answer without any in-memory state from the first listener.

- [ ] **Step 5: Run package tests in dependency order**

Run:

```bash
pnpm --filter @synergy/review-core test
pnpm --filter @synergy/cli test
pnpm --filter @synergy/preview test
pnpm --filter @synergy/plugin-guard test
```

Expected: all package tests pass.

- [ ] **Step 6: Run repository quality gates**

Run:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

Expected: all commands exit 0 with no TypeScript, Biome, Vitest, or build failures.

- [ ] **Step 7: Perform a manual dogfood smoke**

Against a small local fixture repository:

1. Create a staged review and confirm the browser opens `/r/<workspace>/<revision>`.
2. Navigate with mouse and `J/K`; mark an item with `R`.
3. Select a line, queue a question, start a fresh wait task, answer it, and confirm the browser updates.
4. Modify one item, refresh, and confirm only that item needs review.
5. Create a scope review and confirm ignored untracked content is absent.
6. Toggle light/dark themes and verify review chrome changes with the existing Synergy theme.

- [ ] **Step 8: Run a final logic and scope review**

Confirm there is no phase terminology in review code, no Vouch integration, no standalone HTML generation, no hardcoded review palette, no silent source advance, no duplicate snapshot on identical create, and no unanswered-question path that reports ready.
