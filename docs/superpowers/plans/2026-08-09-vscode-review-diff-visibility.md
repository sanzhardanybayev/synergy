# VS Code Review Diff Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show removed lines in panel + editor, open whole files from file rows, always-available native diff per file/hunk, and a global diff on/off toggle in the Synergy Review VS Code extension.

**Architecture:** Pure diff math (reverse-apply, file-wide decoration ranges) lives in `src/editor/` vscode-free modules with vitest coverage. A new `synergy-review-base:` virtual-document scheme serves pre-change file content (reverse-apply → `git show baseSha:path` → captured-snapshot fallback) for `vscode.diff`. The webview gains inline hunk diff bodies and a persisted global toggle; the provider gains `openFile`/`setDiffVisible` handling and hunk-reveal on native diff.

**Tech Stack:** TypeScript strict, vanilla-DOM webview (`media/panel.js`, JSDoc-typechecked), vitest unit tests, esbuild bundle, `@vscode/test-electron` integration suite.

## Global Constraints

- No hardcoded palette hex in `media/panel.css` — only `--syn-*` / `--vscode-*` variables.
- Only `src/host.ts`, `src/extension.ts`, `src/panel/webview-html.ts`, `src/panel/ReviewViewProvider.ts` (type-only), `src/editor/*.ts` may import `vscode`.
- No review-core schema changes.
- Behavior change under `packages/` ⇒ `.claude-plugin/plugin.json` version bump required (release-gate CI). Never hand-edit `marketplace.json` or `SKILL.md` stamps — lefthook `version-sync` derives them.
- Webview CSP: no inline `style` attributes (use classes or CSSOM), scripts from `media/` only.
- Commits/PR: no AI attribution trailers. Use `pnpm`, not npm/yarn.

---

### Task 1: Pure base-content math (`reverseApplyHunks`)

**Files:**
- Create: `packages/vscode-extension/src/editor/base-content.ts`
- Test: `packages/vscode-extension/src/editor/base-content.test.ts`

**Interfaces:**
- Produces: `reverseApplyHunks(diskText: string, file: DiffFile): string | undefined` — reconstructs the pre-change (base) content of `file` from the current on-disk text by removing `add` lines and re-inserting `remove` lines. Verification-first: every `context`/`add` line is checked against the disk text at its `newLine` position; any mismatch returns `undefined` (drifted — caller falls back). Also `baseTextFromHunks(file: DiffFile): string` — best-effort base from hunks alone (context + remove lines), used for deleted files.

- [ ] **Step 1: Write failing tests** — clean reverse-apply round trip (context+add+remove), file with multiple hunks, added file (`status: 'added'` → returns `''` without touching disk text), drifted disk content → `undefined`, `noNewlineAtEnd` handling, trailing-newline preservation.
- [ ] **Step 2: Run `pnpm --filter synergy-vscode test -- base-content` — expect FAIL (module missing).**
- [ ] **Step 3: Implement.** Split disk text into lines (track trailing `\n`). Walk hunks in order with a disk cursor (1-indexed `newLine`): copy unchanged disk lines before `hunk.newStart`; inside a hunk, `context`/`add` verify `lines[newLine-1] === line.text` (mismatch → `undefined`), `context` emits, `add` skips, `remove` emits `line.text`; after last hunk copy the tail.
- [ ] **Step 4: Tests pass.**
- [ ] **Step 5: Commit `feat(vscode): pure reverse-apply base-content math`.**

### Task 2: File-wide decoration ranges

**Files:**
- Modify: `packages/vscode-extension/src/editor/decoration-ranges.ts`
- Test: `packages/vscode-extension/src/editor/decoration-ranges.test.ts`

**Interfaces:**
- Produces: `fileDecorationRanges(file: DiffFile): HunkDecorationRanges` — union of per-hunk added/removed ranges across every hunk in the file (iterate `file.hunks`, reuse the existing per-hunk walk; hunks without `reviewItemId` still count — extract the walk into a helper taking a `DiffHunk`).

- [ ] **Step 1: Failing test — file with two hunks yields concatenated added ranges + removed anchors; empty hunks yields empty ranges.**
- [ ] **Step 2: Refactor `hunkDecorationRanges` body into `rangesForHunk(hunk)`; add `fileDecorationRanges`. Existing tests stay green.**
- [ ] **Step 3: Commit `feat(vscode): file-wide decoration ranges`.**

### Task 3: Wire protocol additions

**Files:**
- Modify: `packages/vscode-extension/src/panel/messages.ts`
- Test: `packages/vscode-extension/src/panel/messages.test.ts` (create)

**Interfaces:**
- Produces (FromWebview):
  - `{ kind: 'openFile'; path: string }`
  - `{ kind: 'openNativeDiff'; path: string; reviewItemId?: string }` (extended)
  - `{ kind: 'setDiffVisible'; value: boolean }`

- [ ] **Step 1: Failing validation tests for the three shapes (valid, missing field, wrong type ⇒ undefined; openNativeDiff without reviewItemId still valid).**
- [ ] **Step 2: Implement types + `parseFromWebview` branches.**
- [ ] **Step 3: Tests pass. Commit `feat(vscode): openFile/setDiffVisible/diff-reveal messages`.**

### Task 4: Base-content provider + native diff rework

**Files:**
- Modify: `packages/vscode-extension/src/editor/base-content.ts` (add async resolver w/ git fallback)
- Create: `packages/vscode-extension/src/editor/base-provider.ts`
- Modify: `packages/vscode-extension/src/editor/native-diff.ts`
- Modify: `packages/vscode-extension/src/extension.ts` (register provider)
- Test: extend `base-content.test.ts` (resolver decision logic with injected git runner)

**Interfaces:**
- Produces:
  - `resolveBaseContent(opts: { projectRoot: string; snapshot: ReviewSnapshot; path: string; readDisk: (abs: string) => string | undefined; gitShow: (root: string, sha: string, path: string) => string | undefined }): { text: string; origin: 'reverse-apply' | 'git' | 'hunks-only' } | undefined` — order: added-file empty base → reverse-apply vs disk → `gitShow(baseSha, previousPath ?? path)` when snapshot.source carries `baseSha` → `baseTextFromHunks` as `'hunks-only'`. Binary files ⇒ undefined.
  - `base-provider.ts`: `BASE_SCHEME = 'synergy-review-base'`, `baseUri(ref, path)`, `parseBaseUri(uri)`, `registerBaseProvider(context, resolve)` — mirror snapshot-provider.ts exactly.
  - `native-diff.ts`: `openNativeDiff(projectRoot, ref, path, revealRange?: ReviewRange)` — left = `baseUri(ref, path)`, right = working-tree file; pass `{ selection }` TextDocumentShowOptions when `revealRange` given; title `Synergy: ${path} (base vs current)`.
- Consumes: Task 1 functions.

- [ ] **Step 1: Failing resolver tests (fake readDisk/gitShow): reverse-apply wins; drifted → git; no baseSha → hunks-only; binary → undefined.**
- [ ] **Step 2: Implement resolver (pure, DI for disk/git). Real `gitShow` helper via `execFileSync('git', ['show', `${sha}:${path}`])` wrapped in try/catch, exported for wiring.**
- [ ] **Step 3: base-provider.ts + extension.ts registration; ReviewViewProvider gains `resolveBaseContent(uri)` mirroring `resolveSnapshotContent` (adds a one-line `//` origin banner only for `hunks-only`).**
- [ ] **Step 4: Rework native-diff.ts signature. Typecheck. Commit `feat(vscode): base-content virtual docs power native diff`.**

### Task 5: Provider + host behavior

**Files:**
- Modify: `packages/vscode-extension/src/host.ts` (add `openFile(absPath): Promise<void>`, `clearDecorations(): void`)
- Modify: `packages/vscode-extension/src/panel/ReviewViewProvider.ts`

**Interfaces:**
- Consumes: Tasks 2–4.
- Produces: message handling — `openFile` opens full working file + `fileDecorationRanges` decorations when `diffVisible`; `openHunk` gates decorations on `diffVisible`; `openNativeDiff` resolves the item range for reveal when `reviewItemId` present; `setDiffVisible` stores flag, clears decorations when false. `diffVisible` defaults `true`, lives on the provider.

- [ ] **Step 1: Implement host methods (`openFile` = openTextDocument+show, no reveal; `clearDecorations` = apply empty ranges to active editor).**
- [ ] **Step 2: Implement provider handlers.**
- [ ] **Step 3: Typecheck + unit suite green. Commit `feat(vscode): full-file open, diff toggle gating`.**

### Task 6: Webview UI

**Files:**
- Modify: `packages/vscode-extension/media/panel.js`
- Modify: `packages/vscode-extension/media/panel.css`

**Interfaces:** Consumes Task 3 message shapes.

- [ ] **Step 1: State: add `diffVisible` (persisted via `vscode.getState()/setState()`, default true).**
- [ ] **Step 2: Toolbar (bundle screen): `Diff on/off` toggle button — flips state, posts `setDiffVisible`, re-renders.**
- [ ] **Step 3: `renderHunkRow`: header gains a small `diff` button (`stopPropagation`, posts `openNativeDiff` with path + reviewItemId). Below `.hunk-description`, when `diffVisible` and snapshot kind is `diff`, render `.hunk-diff`: per `DiffLine` a `.diff-line diff-line-add|remove|context` row with old/new gutters + text (lookup: `snapshot.files.find(f => f.path === item.path)`, hunk by `reviewItemId === item.id`).**
- [ ] **Step 4: `renderFileRow`: file-path span gets own click (stopPropagation → `openFile`); actions row always rendered when expanded: `Open diff` (all files) + `Show captured snapshot` (drifted only).**
- [ ] **Step 5: CSS: `.hunk-diff` monospace block, `overflow-x: auto`, line rows with gutter columns; add/remove backgrounds from `--syn-success-soft` / `--syn-danger-soft`, text `--syn-fg`; toggle button active state via `--syn-accent-soft`.**
- [ ] **Step 6: `tsc -p tsconfig.media.json` green. Commit `feat(vscode): inline hunk diffs, file open, diff toggle UI`.**

### Task 7: Verify, version, ship

- [ ] **Step 1: `pnpm --filter synergy-vscode typecheck && pnpm --filter synergy-vscode test` green.**
- [ ] **Step 2: `pnpm --filter synergy-vscode build && pnpm --filter synergy-vscode test:integration` green.**
- [ ] **Step 3: Bump `.claude-plugin/plugin.json` version (minor). Rebuild whatever release artifacts the repo scripts derive (version-sync via lefthook on commit; rebuild extension `dist/` + `.vsix` if tracked).**
- [ ] **Step 4: Commit, push branch, open PR (gh account `sanzhardanybayev`), wait CI, merge.**
- [ ] **Step 5: Post-merge on main: pull, `pnpm install`, build + package extension, smoke-test against `.synergy/reviews/synergy-pr-26` bundle via integration host.**
