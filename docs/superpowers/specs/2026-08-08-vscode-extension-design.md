# Synergy Review - VS Code / Cursor Extension

- **Status:** Approved (conversational design approved 2026-08-08)
- **Date:** 2026-08-08
- **Relationship to existing Synergy:** Additive. Consumes the same durable review
  workspaces as the web preview. Builds on `2026-07-19-synergy-review-design.md` and
  `2026-08-08-review-ui-v2-design.md` (file-centric model, file-level insights, review
  index data).

## Problem

The web review portal explains and tracks a review well, but its code panes are static:
the reviewer cannot jump to a definition, find references, or walk the surrounding
module. Reviewers want the same guided review structure inside VS Code or Cursor, where
the code under review is the real working tree and the editor's full language
intelligence (LSP, AST-backed navigation) is available.

## Goals

- One extension artifact that runs in both VS Code and Cursor.
- A dedicated left pane mirroring the web review structure: session list, groups, files,
  hunks with per-hunk reviewed state, file-level and per-hunk descriptions, private
  notes, and progress.
- Clicking a hunk opens the real file in the editor at the hunk's range, with full LSP
  navigation. Diff context appears as native editor affordances.
- Works with zero running Synergy processes by reading review workspaces from disk;
  upgrades to live updates when the preview daemon is running.
- Review state edits (checkboxes, notes) made in the extension are the same durable
  files the web UI reads, and vice versa.

## Non-goals

- A question rail or in-extension agent chat in v1. The reviewer selects lines and uses
  the Claude Code IDE connection or the editor's built-in chat instead.
- Marketplace publication in v1 (local `.vsix` install only; publish later if wanted).
- Rendering MDX spec sessions in the extension. Review only.
- Editing code from the review pane. The editor edits code; the pane records review
  state.

## Design

### B1. Package and architecture

- New workspace package `packages/vscode-extension`:
  - TypeScript, esbuild bundle (single `extension.js`), `@synergy/review-core` bundled
    in. No runtime dependency on the daemon or CLI.
  - `vsce package` produces a `.vsix`; a pnpm script builds it. Installed manually in
    VS Code and Cursor (`code --install-extension`, `cursor --install-extension`).
  - Stable VS Code API only, no proposed APIs, so the same `.vsix` works in Cursor.
- **Data path (daemon optional):**
  - Primary: read `.synergy/reviews/` in each open workspace folder directly through
    `@synergy/review-core`, with a file watcher for refresh. Everything works with the
    daemon down.
  - When the preview daemon (port 4321) responds, subscribe to its SSE stream for live
    answer/presence updates. Detection is passive and failure is silent; the fs watcher
    remains the source of truth.
- **Writes:** checkbox and note edits go through `@synergy/review-core` (same schemas,
  atomic writes, same lock discipline as the CLI). Web and extension converge through
  their respective watchers.

### B2. UI surfaces

- **Activity-bar container** "Synergy Review" with one webview view (left pane):
  - Session list (same data shape as the web `/api/reviews` index, computed locally):
    subject, progress, updated time, badges. Ten sessions prepared by ten sub-agents
    show as ten entries.
  - Selecting a session shows the review tree: groups, files (tri-state checkbox,
    reviewed count), and per-file hunks with check state, mirroring the web sidebar and
    the file-centric stage model. File-level broad description and per-hunk
    descriptions render in the pane. Private notes are editable in the pane.
  - Visual language matches the web (Ember & Graphite tokens inlined into the webview
    stylesheet; tokens remain the single palette source).
- **Code navigation:**
  - Clicking a hunk opens the real file from the working tree at the hunk's range and
    reveals it in the active editor column. LSP features (go to definition, references,
    hover) work natively because the buffer is a normal file.
  - Diff context: gutter decorations mark the hunk's added/changed ranges in the open
    editor. A command "Synergy: Open native diff" opens VS Code's built-in diff editor
    for the file (captured base vs current file).
- **Drift handling:** review revisions are immutable snapshots; the working tree may
  have moved. Fingerprints from the captured revision are compared with the current
  file; on mismatch the pane shows a "source drifted" badge on the file, hunk jumps
  still open the live file (walking real code is the point), and a command "Synergy:
  Show captured snapshot" opens the captured content as a readonly virtual document for
  side-by-side comparison.

### B3. Testing

- `@synergy/review-core` read/write behavior is already covered by its own tests.
- Extension unit tests (vitest, VS Code API behind a thin abstraction so no extension
  host is needed): workspace scanner, session-list assembly, drift detection, hunk
  range-to-editor mapping.
- Manual: install the `.vsix` in both VS Code and Cursor; verify a ten-session list,
  hunk jump accuracy, LSP navigation from reviewed code, checkbox/note sync between a
  running web preview and the extension, and daemon-down operation.

## Error handling

- Missing or corrupt workspaces appear as degraded session entries; the pane never
  fails wholesale.
- Daemon detection failures are silent; the extension never surfaces connectivity
  errors unless the user runs an explicit daemon-dependent command.
- Drifted files never block navigation; they only badge and offer the snapshot view.
