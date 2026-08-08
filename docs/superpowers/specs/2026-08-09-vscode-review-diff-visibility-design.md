# VS Code Review Pane: Diff Visibility & Full-File Navigation

Date: 2026-08-09
Status: Approved design

## Problem

The extension's review panel shows only `@@` hunk headers - no diff bodies. In the
editor, hunk clicks highlight added lines only; removed content is invisible (thin
border anchor). Native diff is offered only for drifted files. File rows cannot open
the file itself, and there is no way to review a file without diff overlays. Reviewers
lack confidence: they cannot see what was removed, and navigation between hunks and
full files is limited.

## Goals

1. Show removed lines (and full diff context) both in the panel and in the editor, at
   hunk level and file level.
2. Let a reviewer open the entire file from a file row (not just jump to hunks).
3. Provide an always-available native-diff entry point per file and per hunk.
4. Provide a global toggle that turns diff presentation off entirely (plain-file
   review mode).

Non-goals: review-core schema changes; file-level notes (existing per-hunk note stays
as-is); browser portal changes.

## Design

### 1. Panel: inline hunk diff bodies

`media/panel.js` currently receives full `DiffHunk.lines` (kind `add`/`remove`/
`context`) via the bundle but never renders them.

Expanded file row order becomes:

1. `.file-description` (unchanged, already first)
2. File-level action row (see §2)
3. Hunk rows, each rendered as:
   - `@@` header label (existing)
   - `.hunk-description` (existing, stays directly above the code)
   - **new** `.hunk-diff` block: one row per `DiffLine`, monospace, with old/new line
     numbers in a gutter. Colors come from VS Code theme variables only
     (`--vscode-diffEditor-insertedTextBackground`,
     `--vscode-diffEditor-removedTextBackground`, editor foreground for context) -
     no hardcoded palette values.
   - existing note textarea (the per-hunk "private note")

The diff block is omitted when the global diff toggle is off (§4). Long hunks render
in a container with `overflow-x: auto`; no horizontal page scroll.

Scope-kind snapshots (`kind: 'scope'`) have no hunks - their items render unchanged.

### 2. Always-present native-diff buttons

Today `Open native diff` appears only when `drift === 'drifted'`. Change:

- Every file row gets an **Open diff** button (plus the existing
  `Show captured snapshot` action for drifted files).
- Every hunk row gets a small **diff** affordance that opens the same native diff and
  reveals that hunk's new-file range.

Native diff = `vscode.diff(baseUri, workingTreeUri)` where `baseUri` is a new virtual
document scheme `synergy-review-base:` serving the **pre-change file content**.

Base-content resolution (new `src/editor/base-content.ts`):

1. **Reverse-apply**: take the on-disk file, reverse-apply the captured hunks
   (added lines out, removed lines in). Valid when the file is undrifted; verified by
   checking each hunk's context/add lines against the disk content before applying.
2. **Fallback `git show <baseSha>:<path>`**: when reverse-apply fails (drifted file,
   mismatch) and `snapshot.source.baseSha` exists, shell out to git in the workspace
   root. Result cached per (revision, path).
3. If both fail: fall back to the existing captured-snapshot diff behavior and surface
   a non-blocking warning in the diff title.

New/renamed/deleted file statuses: added files diff against empty base; deleted files
diff base against empty right side; renames use `previousPath` for base resolution.

### 3. File click opens the whole file

File row splits into two hit targets:

- Chevron / row background: expand-collapse (unchanged behavior).
- File path text: posts a new `openFile` message → host opens the full working-tree
  file and, when the diff toggle is on, applies add/remove decorations for **all**
  hunks in that file (reusing `decoration-ranges.ts` across the file's hunk list),
  revealing the top of the file.

Hunk click behavior unchanged (open at hunk range + decorations), except decorations
are gated by the toggle.

### 4. Global diff toggle

A single toolbar toggle in the panel bundle screen: **Diff on / off**.

- **On** (default): everything above.
- **Off**: panel hides `.hunk-diff` blocks (descriptions, notes, buttons stay);
  `openFile`/`openHunk` open the plain file with no decorations; already-applied
  decorations for open editors are cleared.

State lives in webview persisted state (`vscode.getState`/`setState`) - per-window,
not written to `progress.json`.

### 5. Wire protocol additions

`messages.ts` `FromWebview` gains:

- `{type: 'openFile', path}`
- `{type: 'openDiff', path, reviewItemId?}` (file-level when no item id; hunk-level
  reveals the item range)
- `{type: 'setDiffVisible', value: boolean}` (host keeps current value to gate
  decorations)

All validated in the existing message validator.

## Error handling

- git fallback failures (no git, shallow clone missing baseSha) degrade to snapshot
  diff with a warning; never block opening.
- Reverse-apply is verification-first: on any line mismatch it aborts cleanly to the
  fallback chain instead of producing a wrong base.
- Binary files: no inline diff body, diff button disabled with tooltip.

## Testing

- Unit: reverse-apply (clean apply, drifted mismatch → abort, added/deleted/renamed
  files, no-newline-at-EOF), message validation for the three new messages.
- Existing extension test setup applies; manual E2E pass in the Extension Development
  Host against a real captured PR review (`.synergy/reviews/synergy-pr-26`) covering:
  inline diff rendering, both diff buttons, file open, toggle off, drifted file
  fallback.

## Affected surfaces

`packages/vscode-extension`: `media/panel.js`, `media/panel.css`,
`src/panel/ReviewViewProvider.ts`, `src/panel/messages.ts`,
`src/editor/base-content.ts` (new), `src/editor/native-diff.ts`,
`src/editor/decorations.ts`. No review-core changes. Plugin version bump required
(behavior change under `packages/`).
