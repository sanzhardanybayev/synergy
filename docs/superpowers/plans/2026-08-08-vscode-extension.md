# VS Code / Cursor Review Extension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A VS Code/Cursor extension with a left review pane (sessions, files, hunks, descriptions, notes, checkboxes) where clicking a hunk opens the real file in the editor with full LSP navigation.

**Architecture:** New workspace package `packages/vscode-extension`. `@synergy/review-core` is bundled in and reads/writes `.synergy/reviews/` directly (daemon optional; SSE upgrade when port 4321 responds). One webview view in an activity-bar container renders the pane; a thin host API layer (`host.ts`) isolates `vscode` imports so all logic is unit-testable with vitest.

**Tech Stack:** TypeScript strict, esbuild bundle, `@types/vscode` (stable API only - Cursor compatible), `vsce` for `.vsix`, vitest, Ember & Graphite tokens inlined in the webview stylesheet.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-08-vscode-extension-design.md`.
- Depends on the review-ui-v2 plan being landed (file insights `ReviewInsights.files`, index entry shape). Execute after it.
- Stable VS Code API only; no proposed APIs. Engine floor `"vscode": "^1.90.0"`.
- No em dash in authored text; no AI attribution in commits.
- Behavior change under `packages/` bumps `.claude-plugin/plugin.json` version (release-gate).
- Extension writes go through `@synergy/review-core` only - never hand-rolled JSON writes.
- Webview CSS: token variables copied from `packages/preview/src/theme.css` values into the webview stylesheet; adapt to VS Code theme kind (light/dark) via `body.vscode-light` / `body.vscode-dark` selectors.
- v1 has no question rail and no marketplace publish.

---

### Task 1: Package scaffold + build pipeline

**Files:**
- Create: `packages/vscode-extension/package.json`
- Create: `packages/vscode-extension/tsconfig.json`
- Create: `packages/vscode-extension/esbuild.mjs`
- Create: `packages/vscode-extension/src/extension.ts`
- Create: `packages/vscode-extension/src/host.ts`
- Create: `packages/vscode-extension/.vscodeignore`

**Interfaces:**
- Produces: activatable extension with command `synergy-review.refresh`; `pnpm --filter synergy-vscode build` emits `dist/extension.js`; `pnpm --filter synergy-vscode package` emits `synergy-review-<version>.vsix`.
- `host.ts` exports the seam later tasks mock:

```ts
export interface Host {
  workspaceFolders(): string[];                 // absolute fs paths
  onDidChangeWorkspaceFolders(cb: () => void): { dispose(): void };
  watch(globAbsoluteDir: string, cb: () => void): { dispose(): void };
  openFileAt(absPath: string, startLine: number, endLine: number): Promise<void>;
  showError(message: string): void;
}
export function createVsCodeHost(): Host; // the only file importing 'vscode' besides extension.ts/webview host
```

- [ ] **Step 1: package.json**

```json
{
  "name": "synergy-vscode",
  "displayName": "Synergy Review",
  "description": "Guided code review sessions inside your editor.",
  "version": "0.1.0",
  "publisher": "synergy",
  "private": true,
  "engines": { "vscode": "^1.90.0" },
  "main": "./dist/extension.js",
  "activationEvents": ["onView:synergyReview.panel"],
  "contributes": {
    "viewsContainers": {
      "activitybar": [
        { "id": "synergyReview", "title": "Synergy Review", "icon": "media/icon.svg" }
      ]
    },
    "views": {
      "synergyReview": [
        { "type": "webview", "id": "synergyReview.panel", "name": "Review" }
      ]
    },
    "commands": [
      { "command": "synergy-review.refresh", "title": "Synergy: Refresh Reviews" },
      { "command": "synergy-review.openNativeDiff", "title": "Synergy: Open Native Diff" },
      { "command": "synergy-review.showSnapshot", "title": "Synergy: Show Captured Snapshot" }
    ]
  },
  "scripts": {
    "build": "node esbuild.mjs",
    "watch": "node esbuild.mjs --watch",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "package": "pnpm build && vsce package --no-dependencies"
  },
  "dependencies": { "@synergy/review-core": "workspace:*" },
  "devDependencies": {
    "@types/node": "22.10.1",
    "@types/vscode": "1.90.0",
    "@vscode/vsce": "3.1.0",
    "esbuild": "0.24.0",
    "typescript": "5.6.3",
    "vitest": "2.1.5"
  }
}
```

Add a simple `media/icon.svg` (monochrome glyph, `currentColor`).

- [ ] **Step 2: esbuild.mjs**

```js
import esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const ctx = await esbuild.context({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['vscode'],
  outfile: 'dist/extension.js',
  sourcemap: true,
});
if (watch) await ctx.watch();
else { await ctx.rebuild(); await ctx.dispose(); }
```

`@synergy/review-core` is bundled (not external) so the `.vsix` is self-contained; `vsce package --no-dependencies` skips node_modules.

- [ ] **Step 3: Minimal extension.ts + host.ts**

`extension.ts`:

```ts
import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('synergy-review.refresh', () => {
      void vscode.window.showInformationMessage('Synergy Review: refreshed');
    }),
  );
}

export function deactivate(): void {}
```

`host.ts` implements the `Host` interface with `vscode.workspace.workspaceFolders`, `createFileSystemWatcher`, and `openFileAt` via:

```ts
async openFileAt(absPath, startLine, endLine) {
  const doc = await vscode.workspace.openTextDocument(absPath);
  const editor = await vscode.window.showTextDocument(doc, { preview: false });
  const range = new vscode.Range(startLine - 1, 0, endLine - 1, 0);
  editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
  editor.selection = new vscode.Selection(range.start, range.start);
}
```

- [ ] **Step 4: tsconfig + .vscodeignore + workspace wiring**

`tsconfig.json` extends `../../tsconfig.base.json`, `types: ["node", "vscode"]` - check how sibling packages extend the base and match. `.vscodeignore`: `src/**`, `node_modules/**`, `esbuild.mjs`, `**/*.map`, `tsconfig.json`. Run `pnpm install` to register the new workspace package.

- [ ] **Step 5: Verify build + package**

```bash
pnpm --filter synergy-vscode build && pnpm --filter synergy-vscode typecheck
pnpm --filter synergy-vscode package
ls packages/vscode-extension/*.vsix
```

Expected: `.vsix` produced. Install-smoke it: `code --install-extension packages/vscode-extension/synergy-vscode-0.1.0.vsix`, reload, activity-bar icon appears, refresh command runs.

- [ ] **Step 6: Commit**

```bash
git add packages/vscode-extension pnpm-lock.yaml
git commit -m "feat(vscode): scaffold Synergy Review extension package"
```

---

### Task 2: Data layer - session scanner, review model, writes

**Files:**
- Create: `packages/vscode-extension/src/data/sessions.ts`
- Create: `packages/vscode-extension/src/data/drift.ts`
- Test: `packages/vscode-extension/src/data/sessions.test.ts`
- Test: `packages/vscode-extension/src/data/drift.test.ts`

**Interfaces:**
- Consumes: `createReviewStore`, `ReviewBundle`, `ReviewWorkspace`, `ReviewFileInsight` from `@synergy/review-core`; NO `vscode` imports in this directory.
- Produces:

```ts
// sessions.ts
export interface SessionSummary {
  projectRoot: string;
  workspaceId: string;
  revisionId: string;
  subject: string;               // same labels as web index: "PR #317", "Staged changes", ...
  itemCount: number;
  reviewedCount: number;
  updatedAt: string;
  degraded?: string;
}
export function listSessions(projectRoots: string[]): SessionSummary[];       // sorted updatedAt desc
export function loadBundle(projectRoot: string, ref: ReviewRef): ReviewBundle;
export function setItemStatus(projectRoot: string, ref: ReviewRef, reviewItemId: string, status: 'reviewed' | 'needs-review'): void; // store.patchItemProgress
export function saveNote(projectRoot: string, ref: ReviewRef, reviewItemId: string, note: string): void;

// drift.ts
export type DriftState = 'clean' | 'drifted' | 'missing';
export function fileDrift(projectRoot: string, snapshot: ReviewSnapshot, path: string): DriftState;
```

- [ ] **Step 1: Write failing sessions tests**

Build fixtures by writing real workspace files through `createReviewStore` into a temp dir (mirror how `packages/cli/src/review-actions.test.ts` builds fixtures - read it and reuse the approach):

```ts
it('lists sessions across project roots sorted by updatedAt', () => { /* two temp roots */ });
it('returns degraded entry for corrupt workspace.json', () => { /* write garbage */ });
it('setItemStatus persists via review-core and is visible in reloaded bundle', () => {
  setItemStatus(root, ref, itemId, 'reviewed');
  expect(loadBundle(root, ref).progress.items[itemId]?.status).toBe('reviewed');
});
it('saveNote round-trips', () => { /* note visible after reload */ });
```

- [ ] **Step 2: Run, verify fail; implement sessions.ts**

`listSessions` loops roots, `createReviewStore(root)`, per-workspace try/catch producing degraded entries (same shape as the web `buildReviewIndex` from the review-ui-v2 plan Task 6 - keep subject labels identical). `setItemStatus`/`saveNote` call `store.patchItemProgress(workspaceId, revisionId, reviewItemId, { status })` / `{ note }`.

- [ ] **Step 3: Run sessions tests, verify pass**

```bash
pnpm --filter synergy-vscode test -- sessions
```

- [ ] **Step 4: Write failing drift tests, implement drift.ts**

Tests: scope snapshot whose captured `SourceFile.lines` match a temp file on disk → `'clean'`; edit the file → `'drifted'`; delete → `'missing'`. Diff snapshots: compare the file's current content hash against the snapshot's captured post-image; read how `contentHash` is computed in `review-core` (`hash.ts`, `review-item-identity.ts`) and reuse those helpers rather than inventing a scheme. Implementation reconstructs the captured file text (scope: `SourceFile.lines`; diff: not reconstructable per-file in general, so for diff snapshots hash only the item ranges via existing identity helpers; if a reliable comparison is impossible for a file, return `'drifted'` conservatively only when the file mtime is newer than snapshot `createdAt` AND item context lines no longer match - keep the function pure by taking file text as a parameter if that simplifies testing).

- [ ] **Step 5: Run all data tests + typecheck; commit**

```bash
pnpm --filter synergy-vscode test && pnpm --filter synergy-vscode typecheck
git add packages/vscode-extension/src/data
git commit -m "feat(vscode): review session data layer over review-core"
```

---

### Task 3: Webview pane - session list and review tree

**Files:**
- Create: `packages/vscode-extension/src/panel/ReviewViewProvider.ts`
- Create: `packages/vscode-extension/src/panel/webview-html.ts`
- Create: `packages/vscode-extension/src/panel/messages.ts`
- Create: `packages/vscode-extension/media/panel.css`
- Create: `packages/vscode-extension/media/panel.js`
- Modify: `packages/vscode-extension/src/extension.ts` (register provider + watcher)
- Test: `packages/vscode-extension/src/panel/messages.test.ts`

**Interfaces:**
- Consumes: Task 2 data layer, Task 1 `Host`.
- Produces: webview view `synergyReview.panel` and the message protocol:

```ts
// messages.ts - discriminated unions, validated with small type guards
export type ToWebview =
  | { kind: 'sessions'; sessions: SessionSummary[] }
  | { kind: 'bundle'; bundle: SerializedBundle }   // bundle + per-file drift states
  | { kind: 'error'; message: string };
export type FromWebview =
  | { kind: 'ready' }
  | { kind: 'openSession'; workspaceId: string; revisionId: string }
  | { kind: 'openHunk'; reviewItemId: string }
  | { kind: 'setStatus'; reviewItemId: string; status: 'reviewed' | 'needs-review' }
  | { kind: 'saveNote'; reviewItemId: string; note: string }
  | { kind: 'backToSessions' }
  | { kind: 'openNativeDiff'; path: string }
  | { kind: 'showSnapshot'; path: string };
export function parseFromWebview(value: unknown): FromWebview | undefined;
```

`SerializedBundle` = `{ bundle: ReviewBundle; drift: Record<string, DriftState>; projectRoot: string }`.

- [ ] **Step 1: Write failing messages tests**

```ts
it('parses valid openHunk message', () => {
  expect(parseFromWebview({ kind: 'openHunk', reviewItemId: 'x' })).toEqual({ kind: 'openHunk', reviewItemId: 'x' });
});
it('rejects unknown kinds and malformed payloads', () => {
  expect(parseFromWebview({ kind: 'nope' })).toBeUndefined();
  expect(parseFromWebview({ kind: 'setStatus', reviewItemId: 1 })).toBeUndefined();
});
```

- [ ] **Step 2: Implement messages.ts; run tests green**

- [ ] **Step 3: Implement ReviewViewProvider**

`vscode.WebviewViewProvider`:

- `resolveWebviewView`: set `webview.options = { enableScripts: true, localResourceRoots: [media] }`, html from `webview-html.ts` (CSP with nonce, `panel.css` + `panel.js` via `asWebviewUri`).
- On `ready`: post `sessions` (from `listSessions(host.workspaceFolders())`).
- On `openSession`: `loadBundle` + per-file `fileDrift` → post `bundle`.
- On `setStatus`/`saveNote`: call data layer, then re-post the refreshed bundle.
- On `openHunk`: look up item in the loaded bundle, `host.openFileAt(join(projectRoot, item.path), item.range.start, item.range.end)`; decorations come in Task 4.
- Watch: `host.watch(join(root, '.synergy', 'reviews'), refresh)` per root; refresh re-posts whichever screen is active. Debounce 250 ms.
- All failures → `{ kind: 'error', message }`, never a crash.

- [ ] **Step 4: Implement webview UI (panel.js + panel.css, no framework)**

Vanilla DOM (keeps the bundle tiny and avoids a second React build):

- Session list screen: card per session - subject, progress bar (`reviewedCount/itemCount`), updated time, `Unreadable` badge when degraded. Click → `openSession`.
- Review screen: back button; per group: label; per file: tri-state checkbox (indeterminate when partial), path, `n/m` count, drift badge (`drifted`/`missing`); expanded file shows the file description (from `bundle.insights.files`), then hunks: check state, label, per-hunk description, note textarea (blur → `saveNote`), row click → `openHunk`; buttons for `openNativeDiff` and `showSnapshot` on drifted files.
- `panel.css`: define `--syn-*` variables in `body.vscode-light { ... }` and `body.vscode-dark { ... }` blocks, values copied from `packages/preview/src/theme.css` light/dark blocks; all component rules consume the variables.

- [ ] **Step 5: Wire into extension.ts; manual verify**

```bash
pnpm --filter synergy-vscode build && pnpm --filter synergy-vscode package
code --install-extension packages/vscode-extension/*.vsix
```

Open a repo containing `.synergy/reviews/` sessions: list renders, opening a session renders tree with descriptions, checkbox toggles persist (verify the JSON on disk changed), clicking a hunk opens the file at the right line, LSP go-to-definition works from that file. Also confirm in Cursor with `cursor --install-extension`.

- [ ] **Step 6: Run tests + typecheck; commit**

```bash
pnpm --filter synergy-vscode test && pnpm --filter synergy-vscode typecheck
git add packages/vscode-extension
git commit -m "feat(vscode): review pane with sessions, tree, and editor jumps"
```

---

### Task 4: Editor affordances - decorations, native diff, snapshot view

**Files:**
- Create: `packages/vscode-extension/src/editor/decorations.ts`
- Create: `packages/vscode-extension/src/editor/native-diff.ts`
- Create: `packages/vscode-extension/src/editor/snapshot-provider.ts`
- Modify: `packages/vscode-extension/src/panel/ReviewViewProvider.ts` (invoke on openHunk/openNativeDiff/showSnapshot)
- Test: `packages/vscode-extension/src/editor/decorations.test.ts` (range math only)

**Interfaces:**
- Consumes: `ReviewBundle`, `DiffFile`, `resolveBrowserReviewItemContext` (row line numbers), Task 1 `Host`.
- Produces:

```ts
// decorations.ts
export interface HunkDecorationRanges { added: ReviewRange[]; removed: ReviewRange[] } // 1-based new-file lines; removed anchor to the line after which content was removed
export function hunkDecorationRanges(file: DiffFile, reviewItemId: string): HunkDecorationRanges;
export function applyHunkDecorations(editor: vscode.TextEditor, ranges: HunkDecorationRanges): void;
// native-diff.ts
export async function openNativeDiff(projectRoot: string, snapshot: ReviewSnapshot, path: string): Promise<void>;
// snapshot-provider.ts
export const SNAPSHOT_SCHEME = 'synergy-review-snapshot';
export function registerSnapshotProvider(context: vscode.ExtensionContext, resolve: (uri: vscode.Uri) => string | undefined): void;
export function snapshotUri(ref: ReviewRef, path: string): vscode.Uri;
```

- [ ] **Step 1: Write failing range-math tests**

```ts
it('maps an add-only hunk to one added range in new-file coordinates', () => {
  // DiffFile fixture: hunk newStart 10, lines: 2 context, 3 add, 1 context
  expect(hunkDecorationRanges(file, itemId)).toEqual({
    added: [{ start: 12, end: 14 }], removed: [],
  });
});
it('maps remove-only lines to a removed anchor', () => { /* removed: [{ start: 11, end: 11 }] */ });
it('throws for unknown reviewItemId', () => { /* ... */ });
```

- [ ] **Step 2: Run, verify fail; implement pure range math**

Walk `hunk.lines` tracking `newLine`; contiguous `add` runs become `added` ranges; contiguous `remove` runs anchor at the current `newLine` position. `applyHunkDecorations` uses two `window.createTextEditorDecorationType`s: added → `backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground')`, removed → gutter marker via `border` on `ThemeColor('diffEditor.removedTextBackground')`. Recreate types lazily once, dispose on deactivate.

- [ ] **Step 3: Native diff + snapshot provider**

`snapshot-provider.ts`: `TextDocumentContentProvider` for `SNAPSHOT_SCHEME`; content resolved from the loaded bundle - scope files from `SourceFile.lines`, diff files from the captured post-image where hunks apply (fallback: hunk texts concatenated with headers when the full post-image is not reconstructable; label the document accordingly).

`native-diff.ts`:

```ts
await vscode.commands.executeCommand(
  'vscode.diff',
  snapshotUri(ref, path),                          // captured base
  vscode.Uri.file(join(projectRoot, path)),        // current file
  `Synergy: ${path} (captured vs current)`,
);
```

- [ ] **Step 4: Wire into provider; openHunk now applies decorations after reveal; run tests + typecheck**

```bash
pnpm --filter synergy-vscode test && pnpm --filter synergy-vscode typecheck
```

- [ ] **Step 5: Manual verify + commit**

Rebuild, reinstall `.vsix`, verify: hunk jump shows highlight ranges; drifted file badge offers Show Captured Snapshot (readonly doc opens); Open Native Diff shows captured-vs-current.

```bash
git add packages/vscode-extension
git commit -m "feat(vscode): hunk decorations, native diff, snapshot documents"
```

---

### Task 5: Optional daemon SSE upgrade

**Files:**
- Create: `packages/vscode-extension/src/data/daemon.ts`
- Modify: `packages/vscode-extension/src/panel/ReviewViewProvider.ts`
- Test: `packages/vscode-extension/src/data/daemon.test.ts`

**Interfaces:**
- Consumes: preview daemon `GET /api/reviews/:ws/:rev/stream` (SSE, existing endpoint from review branch).
- Produces:

```ts
export interface DaemonLink {
  dispose(): void;
}
export function tryConnectDaemon(
  reference: ReviewRef,
  onEvent: () => void,          // any stream event → refresh bundle
): DaemonLink;                  // silent no-op link when daemon is down
```

- [ ] **Step 1: Write failing tests**

Using a local `node:http` test server: emits SSE events → `onEvent` fires; server absent → `tryConnectDaemon` resolves to a no-op without throwing or logging errors; dispose closes the socket.

- [ ] **Step 2: Implement with plain `http.get` to `http://127.0.0.1:4321`**

2s connect timeout, treat any error as daemon-down, no retry storm (single reconnect attempt on next `openSession`). The fs watcher from Task 3 remains authoritative; SSE only accelerates refresh.

- [ ] **Step 3: Wire: connect on openSession, dispose on backToSessions/deactivate; run tests; commit**

```bash
pnpm --filter synergy-vscode test && pnpm --filter synergy-vscode typecheck
git add packages/vscode-extension
git commit -m "feat(vscode): live refresh via preview daemon SSE when available"
```

---

### Task 6: Release wiring + docs

**Files:**
- Modify: `.claude-plugin/plugin.json` (version bump)
- Modify: `CLAUDE.md` (Layout table: add `packages/vscode-extension`)
- Modify: `README.md` (short install section for the extension)

**Interfaces:**
- Consumes: everything prior.
- Produces: documented, versioned, pushed main.

- [ ] **Step 1: Docs**

CLAUDE.md Layout list: `packages/vscode-extension - VS Code/Cursor review pane; local .vsix, bundles review-core.` README: build + `code --install-extension` / `cursor --install-extension` instructions.

- [ ] **Step 2: Version bump + full suite**

Bump `.claude-plugin/plugin.json` minor (e.g. 0.14.0 → 0.15.0).

```bash
pnpm -r test && pnpm -r typecheck && pnpm biome check .
```

- [ ] **Step 3: Commit and push**

```bash
git add .claude-plugin/plugin.json CLAUDE.md README.md
git commit -m "release: vscode review extension"
git push origin main
```

---

## Self-Review Notes

- Spec coverage: B1→Tasks 1-2 (+5 daemon-optional), B2→Tasks 3-4, B3→tests per task + manual steps in Tasks 3-5. Error handling: degraded sessions (Task 2), webview error messages (Task 3), silent daemon failures (Task 5), drift never blocks navigation (Tasks 2/4).
- `Host` seam keeps `vscode` imports out of `src/data`, so vitest runs without an extension host.
- Subject labels intentionally duplicated from web `buildReviewIndex` shape; if drift becomes annoying, lift into review-core later (YAGNI now - different platforms, four-line function).
