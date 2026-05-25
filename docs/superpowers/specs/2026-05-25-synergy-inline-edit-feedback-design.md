# Synergy v2 — Inline Edits + Feedback Loop

- **Status:** Draft
- **Date:** 2026-05-25
- **Relationship to prior specs:** Additive to `2026-05-23-synergy-multipage-preview-design.md`. The multi-page preview shape is unchanged; this design adds the editor and feedback layer on top.

## Problem

The current preview is read-only. After Claude writes a session, the human iterates by going back to Claude with prose feedback ("change X to Y in `01-architecture`"). This is slow and lossy — the human reads the spec in the browser but describes feedback in a separate window. Two missing capabilities:

1. **Direct edits in the preview.** Fix a typo, tweak a phrase, flip a phase status — no round-trip through Claude.
2. **In-browser feedback collection.** Highlight a passage, leave a note for Claude to address. Notes accumulate in a queue Claude can pull on demand.

## Goals

- Inline text editing of prose blocks (paragraphs, list items, headings) with an explicit **Apply / Discard** gesture per edit — never auto-save.
- Manual phase-status changes via a status dropdown — same Apply / Discard workflow.
- A **diff view** toggle on every spec page that highlights changes since you last reviewed the file — so you can see exactly what Claude changed at a glance, no terminal switch.
- Selection-anchored comments — Google Docs style. Each comment is a single-shot note (no threading). Anchor carries both **line/col coordinates** (pinpoint for Claude) and **before/selected/after context** (drift-tolerant).
- Pull-based handoff to Claude Code via a `/synergy-feedback` slash command that loads the queue for the **browser-active session** into the conversation.
- All persistence on disk: MDX files are the source of truth (versioned by git); comments are markdown files in `.synergy/feedback/<session>/`. No SQLite for spec content. Versioning = git.
- No new framework: extend the existing Vite plugin with middleware.

## Non-goals (v2)

- Rich inline marks (bold / italic / links mid-paragraph). Edit the source MDX in Claude for those.
- Adding new spec-kit components from the UI (`<Risk>`, `<OpenQuestion>`, `<Timeline>`, etc.). Claude adds those.
- Reordering phases or sections from the UI.
- Editing component props beyond phase status (no `<Risk severity>` editor, no `<Timeline>` date editor).
- Comment threading. One comment = one note; resolve / reject is the only follow-up.
- Push to an active Claude session. Pull-based via slash command only.
- Mobile editing. v2 targets desktop Chrome/Firefox; mobile is degraded to read + add-comment.
- SQLite. No database in v2. Spec content lives in MDX files (versioned by git); comments live as markdown files; review state lives in a tiny JSON sidecar.
- Custom file-version history (Claude-edit-1, Claude-edit-2, etc.). Versioning is git. If you want a finer history, you commit more often.
- Project-level / cross-session feedback. Every comment is scoped to one session + one file. Cross-session notes go in a session of their own.

## System overview

```
┌─────────────────────────────────────────────────────────────────────┐
│  BROWSER (preview UI on :4321)                                      │
│   sidebar │ spec page (contenteditable blocks with Apply/Discard,   │
│           │  <Status> dropdown with Apply/Discard, select-text → "+"│
│           │  comment button, diff-view toggle) │ comments panel     │
└─────────────────────────────────────────────────────────────────────┘
                            │ fetch(...)
                            ▼
┌─────────────────────────────────────────────────────────────────────┐
│  VITE DEV SERVER                                                    │
│    existing: MDX rollup, HMR, sessions virtual module               │
│    NEW rehype pass: source-range annotator                          │
│    NEW middleware (synergy-edit):                                   │
│       PUT   /api/edit              span replace in MDX              │
│       PATCH /api/status            status prop / frontmatter rewrite│
│       POST  /api/feedback          write comment file               │
│       GET   /api/feedback          list comments for a session      │
│       PATCH /api/feedback/:id      resolve / reject                 │
│       GET   /api/diff?file=...     git diff payload for one file    │
│       POST  /api/review            mark file as reviewed @ HEAD     │
│       POST  /api/active-session    browser pings active session     │
└─────────────────────────────────────────────────────────────────────┘
                            │ read / write files
                            ▼
┌─────────────────────────────────────────────────────────────────────┐
│  .synergy/sessions/<session>/*.mdx       source of truth (git)      │
│  .synergy/feedback/<session>/*.md        NEW: comment queue         │
│  .synergy/active-session                 NEW: 1-line: current sess. │
│  .synergy/review-state.json              NEW: {file: {commit, at}}  │
└─────────────────────────────────────────────────────────────────────┘
                            │ Claude reads when user types
                            ▼ /synergy-feedback
┌─────────────────────────────────────────────────────────────────────┐
│  CLAUDE CODE SESSION (separate process)                             │
│   /synergy-feedback → skill reads .synergy/active-session,          │
│   loads `.md` files in that session with status: open, addresses    │
│   each, PATCHes status to resolved / rejected.                      │
└─────────────────────────────────────────────────────────────────────┘
```

## Backend — Vite middleware (`synergy-edit`)

A new plugin in `packages/preview/vite-plugin-edit.ts`, registered alongside `synergy-sessions` in `vite.config.ts`. Connect-style middleware, JSON in / JSON out. Bound to `localhost` only — no auth.

**Path convention:** every endpoint takes a `file` field whose path is **relative to the sessions root** (the directory `vite-plugin-sessions` already calls `sessionsDir`, i.e. `<project>/.synergy/sessions/`). The server resolves, normalizes, and asserts the result stays inside `sessionsDir` — any `..` traversal returns 400.

### `PUT /api/edit`

Replace a span in an MDX file.

```jsonc
// request
{
  "file": "sessions/2026-05-25-foo/phases/02-impl/spec.mdx",
  "sourceStart": { "line": 14, "col": 2 },
  "sourceEnd":   { "line": 14, "col": 27 },
  "expectedText": "the old paragraph text",  // optimistic concurrency
  "newText": "the new paragraph text"
}
// response 200
{ "ok": true, "newSize": 4123 }
// response 409 if expectedText doesn't match what's currently at the range
{ "error": "stale_range", "currentText": "..." }
```

The server resolves `file` relative to the sessions root, refuses paths outside it, and writes atomically (write to `<file>.tmp` then rename). HMR picks up the change.

### `PATCH /api/status`

Two shapes — for phase frontmatter and for inline `<Status value="...">` props.

```jsonc
// shape 1 — phase frontmatter
{
  "kind": "phase-frontmatter",
  "file": "sessions/.../phases/02-impl/spec.mdx",
  "newStatus": "in-progress"
}
// shape 2 — inline component prop
{
  "kind": "inline-status",
  "file": "sessions/.../00-overview.mdx",
  "sourceStart": { "line": 42, "col": 0 },
  "sourceEnd":   { "line": 42, "col": 25 },
  "expectedText": "<Status value=\"draft\" />",
  "newStatus": "in-progress"
}
```

Same atomic-write + 409 semantics as `/api/edit`.

### `POST /api/feedback`

Append a new comment file.

```jsonc
{
  "session": "2026-05-25-foo",
  "file": "phases/02-impl/spec.mdx",
  "anchor": {
    "before": "we sign users in via ",
    "selected": "SSO",
    "after": " and redirect them to ..."
  },
  "body": "Should this also cover SAML, or just OAuth-style SSO?"
}
// response
{ "id": "2026-05-25T093045-abc123", "path": ".synergy/feedback/2026-05-25-foo/2026-05-25T093045-abc123.md" }
```

### `GET /api/feedback?session=...`

Returns all comment files for a session, parsed (frontmatter + body), sorted oldest first. Used by the comments panel.

### `PATCH /api/feedback/:id`

```jsonc
{ "status": "resolved", "resolution": "Added a paragraph clarifying ..." }
// or
{ "status": "rejected", "rejection_reason": "Out of scope for this session." }
```

Updates the frontmatter of the corresponding markdown file. Used by both the browser ("✕ dismiss") and the slash command.

### `GET /api/diff?file=<relative-path>`

Returns the diff for a single file, used by the diff view.

```jsonc
// response
{
  "file": "sessions/.../00-overview.mdx",
  "head": "abc1234",                  // commit sha of HEAD (full sha)
  "reviewedAt": "def5678",            // commit sha of last reviewed (null if never)
  "hunks": [
    {
      "oldStart": 14, "oldLines": 3,
      "newStart": 14, "newLines": 4,
      "lines": [
        { "kind": "context", "text": "## Goals" },
        { "kind": "context", "text": "" },
        { "kind": "remove",  "text": "We want the spec editable in the preview." },
        { "kind": "add",     "text": "We want the spec editable in the preview." },
        { "kind": "add",     "text": "Each edit is gated by an explicit Apply." }
      ]
    }
  ],
  "uncommittedHunks": [ /* same shape, working tree vs HEAD */ ]
}
```

Internally calls `git diff <reviewedAt>..HEAD -- <file>` plus `git diff -- <file>` for uncommitted changes. Both can be empty.

### `POST /api/review`

Marks a file as reviewed at the current HEAD. Updates `.synergy/review-state.json`.

```jsonc
// request
{ "file": "sessions/.../00-overview.mdx" }
// response
{ "ok": true, "reviewedAt": "abc1234" }
```

If there are uncommitted changes when this is called, response includes `{ warn: "uncommitted_changes_present" }` — those changes will still appear in the next diff view until they're committed.

### `POST /api/active-session`

Browser writes the currently-viewed session to disk. Called on route change and on `window.focus`.

```jsonc
// request
{ "session": "2026-05-25-foo-feature" }
// response
{ "ok": true }
```

Server writes `.synergy/active-session` as a JSON file:

```json
{ "session": "2026-05-25-foo-feature", "lastSeen": "2026-05-25T09:42:11Z" }
```

No heartbeat (route change + focus is enough). The skill side has its own staleness logic (see *Slash command + skill*).

### Body parsing & response helpers

One ~20-line helper module (`packages/preview/src/server/http.ts`):

```ts
export async function readJsonBody(req: IncomingMessage): Promise<unknown> { /* ... */ }
export function sendJson(res: ServerResponse, status: number, body: unknown): void { /* ... */ }
```

No router — we match on `req.method` + a small prefix table. Five endpoints is trivial; we revisit if it grows past ~10.

## Rehype source-range plugin

`packages/preview/src/rehype-source-range.ts`.

When @mdx-js/rollup runs the MDX pipeline, AST nodes carry `position: { start: {line, col, offset}, end: {line, col, offset} }`. We add a rehype pass that copies position onto each leaf-prose element (`p`, `li`, `h1..h6`, `blockquote`, `strong`, `em`, `code`) as data attributes:

```html
<p data-source-line-start="14" data-source-col-start="2"
   data-source-line-end="14" data-source-col-end="27">…</p>
```

We deliberately do **not** annotate custom-component elements (`<Phase>`, `<Status>`, `<Chart>`, etc.) — they stay frozen. The annotator skips elements whose tag matches `/^[A-Z]/`.

**Verification step in the build:** the plugin asserts that position info is present for every leaf-prose node. If MDX position info is missing for a node, build fails loudly — listed as **Open Question 1** below.

## Inline editing — buffer + Apply / Discard

`packages/preview/src/EditableBlock.tsx` (or wired into `MDXComponents`).

- Leaf-prose elements (`p`, `li`, `h1..h6`) become `contentEditable`. Custom components stay read-only.
- **No auto-save.** Edits live in browser memory as a per-block buffer. A block in dirty state shows a small inline action row: **Apply** | **Discard**. A top-of-page toolbar mirrors the count: **Apply all (3)** | **Discard all**.
- **Apply** sends `PUT /api/edit` with the block's source range + serialized markdown. On 200, the buffer clears and the block returns to clean state. On 409 (stale range), a non-disruptive toast preserves the typed text and triggers an HMR refresh so the user can re-apply.
- **Discard** clears the buffer and re-renders the block from the current file content (no network call).
- **List continuation:** on `Enter` inside an `<li>`, we `preventDefault` and insert a new `<li>` sibling, move cursor. If the current `<li>` is empty, we instead exit the list (insert a `<p>` after). Standard markdown-editor behavior.
- **Serialization:** for v2, a block's text content **is** its markdown (no inline marks supported). The source span tracked by the rehype plugin covers **only the prose content** — the list marker (`- `, `* `, `1. `) and heading prefix (`## `) sit outside the span and stay untouched. So the editor replaces the inner text and the markdown structure (markers, indentation, blank lines around the block) is preserved by construction. The serializer is ~30 lines and lives next to the editor.
- **Optimistic concurrency:** Apply sends `expectedText` (the rendered text of the block at last render). The server compares to the current file contents at that span. If they don't match (Claude or another tab wrote since), respond 409.
- **Unload guard:** if the user tries to navigate away (route change) or close the tab with dirty buffers, prompt: "You have N unsaved edits. Apply / Discard / Cancel."
- **Undo:** native browser undo within the buffer's lifetime; clears after Apply or Discard. Acceptable for v2.

## Status flipping — same buffer pattern

- Click the status badge → popover with the 6 status values.
- Selecting a value puts the block into dirty state (badge shows a small "pending" indicator). Apply / Discard buttons appear inline.
- Apply sends `PATCH /api/status`. Discard reverts to the prior value.
- Counts toward the top-toolbar "Apply all".

## Diff view

A toggle in the top toolbar of every spec page: **🔍 Diff: off | on**. When on:

- Browser calls `GET /api/diff?file=...` for each open MDX file on the current page.
- For each hunk, the page overlays color-coded backgrounds:
  - **Green** behind added lines (committed: dark green; uncommitted: light green).
  - **Red strikethrough** for removed lines, inserted between context lines.
  - **Yellow** in the gutter for hunks that contain pending unapplied edits (so you see your own in-progress changes alongside Claude's).
- A floating panel summarizes: **3 added · 1 removed · 2 hunks**, with a **Mark as reviewed** button.
- **Mark as reviewed** calls `POST /api/review` for each currently-visible MDX file. The diff view clears.
- Diff view is non-editable — entering it disables Apply on dirty blocks (the user can still Discard).

Reference for the diff highlights: `git diff <reviewedAt>..HEAD -- <file>` plus `git diff -- <file>` for uncommitted changes, both returned by `/api/diff`.

### Review-state file

`.synergy/review-state.json` — single JSON object keyed by relative file path:

```json
{
  "sessions/2026-05-25-foo/00-overview.mdx":      { "commit": "abc1234", "at": "2026-05-25T09:30:00Z" },
  "sessions/2026-05-25-foo/phases/01-core/spec.mdx": { "commit": "abc1234", "at": "2026-05-25T09:31:12Z" }
}
```

Written atomically (write `.tmp`, rename). Tracked in `.gitignore` (it's per-user / per-machine).

## Status flipping — component changes

- The `<Status>` and `<Phase>` components in `@synergy/spec-kit` learn one new prop pair: `editable?: boolean` and `onChange?: (next: StatusValue) => void`. The preview renders them with `editable=true`; consumers outside the preview keep the default read-only.
- When `editable`, clicking the status badge opens a small popover with the 6 status values (`draft`, `proposed`, `in-progress`, `blocked`, `done`, `shipped`).
- Selecting a value enters dirty state per the buffer pattern above. The actual `PATCH /api/status` fires on Apply. The phase header status uses the `phase-frontmatter` shape; inline `<Status>` in body MDX uses the `inline-status` shape (which carries source range from the rehype plugin).

## Selection-anchored comments

### Adding a comment

1. User selects text within any block (editable or not).
2. A floating "+" button appears near the selection (positioned via `Selection.getRangeAt(0).getBoundingClientRect()`).
3. Click "+" → small composer pops at the same position. User types comment body, hits **Send** (or Esc to cancel).
4. Client computes the anchor:
   - Find the closest ancestor with `data-source-line-start` (a leaf-prose block).
   - Convert the selection start and end to **source `(line, col)` coordinates** within the file (block source start + offset of selection within block, then map back to line/col).
   - Capture context: **30 chars before** the selection in source, **30 chars after**.
   - Result: `{ lineStart, colStart, lineEnd, colEnd, before, selected, after }`.
5. `POST /api/feedback` with `{ session, file, anchor: { lineStart, colStart, lineEnd, colEnd, before, selected, after }, body }`. The server writes the markdown file.

The pair (line/col + context) is intentional: Claude uses line/col for precise file edits; the rendering layer uses before/selected/after to re-anchor across edits (line/col drift after any insertion above the anchor).

### Comments panel

- Right-side collapsible panel. List of pending comments for the current session, sorted by `created` ascending.
- Each item: anchor snippet ("...we sign users in via **SSO** and..."), comment body, file path, age, two buttons: **✓ Resolve** (PATCH status=resolved), **✕ Reject** (prompts for reason, PATCH status=rejected).
- Click an item → scroll the spec page to the anchor and highlight it for 2 seconds.
- A small badge in the top nav shows the open-comment count.

### Anchor re-rendering (highlighting)

On render, for each open comment in the current file:
1. First try `lineStart/colStart..lineEnd/colEnd` directly. If the source text at that span equals `selected`, highlight it. (Common case: nobody edited the file since the comment was added.)
2. Otherwise, search the file for `before + selected + after`. If found uniquely, highlight `selected`.
3. If not found uniquely (drift), mark the comment as **stale** in the panel — still listed, just not highlighted in the doc.

Drift is accepted gracefully. If the user wants to re-anchor a stale comment, they can delete it and add a new one. No automated re-anchoring in v2.

## Feedback file format

One file per comment at `.synergy/feedback/<session>/<id>.md`:

```markdown
---
id: 2026-05-25T093045-abc123
session: 2026-05-25-foo-feature
file: phases/02-implementation/spec.mdx
status: open
created: 2026-05-25T09:30:45Z
anchor:
  lineStart: 42
  colStart:  18
  lineEnd:   42
  colEnd:    21
  before:   "we sign users in via "
  selected: "SSO"
  after:    " and redirect them to ..."
---

Should this also cover SAML, or just OAuth-style SSO?
```

After Claude addresses it, the frontmatter updates in place:

```yaml
status: resolved
resolved_at: 2026-05-25T09:42:11Z
resolution: "Added a paragraph clarifying we only support OAuth SSO for now."
```

(Rejected: `status: rejected`, `rejected_at`, `rejection_reason`.)

Resolved / rejected comments stay on disk as an audit trail. The comments panel hides them by default with a "show resolved" toggle.

## Slash command + skill

### `/synergy-feedback` command

`commands/synergy-feedback.md` — a thin slash command that dispatches to a new skill `synergy:address-feedback`.

### `synergy:address-feedback` skill

`skills/address-feedback/SKILL.md`. Workflow:

1. **Resolve the session:**
   - If the user passed an argument (`/synergy-feedback 2026-05-23-foo`), use it.
   - Else read `.synergy/active-session`. If present and `lastSeen` < 10 min ago, use its `session`.
   - Else prompt the user with a list of sessions that have open feedback ("Which session? 1) … 2) …").
2. List `.synergy/feedback/<session>/*.md` files where `status: open`.
3. For each comment, present to the conversation:
   - File path and **`(lineStart:colStart .. lineEnd:colEnd)`** for precise targeting.
   - Anchor snippet (`before + **selected** + after`).
   - Comment body.
4. For each comment, decide:
   - **Address it:** edit the spec file (use the line/col to target the exact location, falling back to the snippet if drift). Then call `PATCH /api/feedback/:id` with `status: resolved` and a one-line `resolution`.
   - **Reject it:** call `PATCH /api/feedback/:id` with `status: rejected` and a `rejection_reason`. (Don't silently ignore.)
5. After the loop, summarize what was addressed / rejected, then run `synergy validate` to catch any broken cross-refs the edits introduced.

The skill is the only piece that needs to know how to call `PATCH /api/feedback/:id` and read `.synergy/active-session` — everything else is plain file IO.

## CLI surface (unchanged)

No new top-level CLI commands. Editing and feedback collection happen in the running preview; consumption happens via the slash command. `synergy preview start | stop | status` and `synergy validate` are unchanged.

## Error handling

| Scenario | Behavior |
|----------|----------|
| Apply hits stale source range (409) | Toast preserves user text; HMR refresh; user can re-apply if still relevant. Buffer is **not** discarded. |
| File deleted between render and Apply (404) | Same toast; the affected block is gone after HMR; buffer cleared. |
| Malformed request (400) | Log to server; toast to user. |
| Filesystem write failure | Retry once; if it still fails, toast with the OS error. Buffer preserved. |
| Stale comment anchor on render (line/col + context both fail) | Show in panel as **stale**; no highlight in doc; user can delete + re-add. |
| `/synergy-feedback` finds zero open comments | Skill reports "queue empty" and exits. |
| `/synergy-feedback` finds no `.synergy/active-session` | Skill prompts user to pick a session (only listing those with open feedback). |
| `.synergy/active-session` is `lastSeen` > 10 min ago | Skill confirms with user before using ("preview was last active 27 min ago — use that session or pick another?"). |
| Concurrent edits by Claude + browser | Last-write-wins after the 409 toast. No CRDT. |
| `<Status>` clicked outside a recognized parent | Popover refuses to render; log to console. |
| `git` not installed / not a repo | Diff view shows "Diff unavailable: not a git repo" and disables the toggle. Editing/comments still work. |
| Unload (route change / tab close) with dirty buffers | Confirm prompt: Apply / Discard / Cancel. |
| `/api/diff` for a file with no prior `review-state.json` entry | Use `git diff HEAD~5..HEAD -- <file>` (last 5 commits) as a sensible default, plus uncommitted. The "Mark as reviewed" button still updates to current HEAD. |

## Testing strategy

- **Vitest unit:**
  - `rehype-source-range`: input MDX → output hast carries correct `data-source-*` attrs on all leaf-prose, skipped on custom components.
  - `server/edit`: span replace preserves trailing newline; 409 on `expectedText` mismatch.
  - `server/status`: frontmatter `status:` line replaced without disturbing other keys; inline prop rewrite leaves siblings untouched.
  - `server/feedback`: POST writes file with correct frontmatter (including line/col); PATCH updates status only; GET returns sorted list.
  - `server/diff`: invokes `git diff` and returns hunk JSON; handles "no review-state entry" and "not a git repo".
  - `server/review`: writes `.synergy/review-state.json` atomically; merges new entries without disturbing siblings.
  - `server/active-session`: writes `.synergy/active-session` atomically with `lastSeen`.
  - `anchor-search`: line/col direct lookup succeeds; `before + selected + after` fallback resolves to a unique match in synthetic source; returns "stale" when neither succeeds.
- **React Testing Library:**
  - `EditableBlock`: typing puts block in dirty state; Apply fires PUT; Discard reverts; Enter in `<li>` adds sibling; Enter in empty `<li>` exits the list.
  - `StatusPopover`: selecting puts block in dirty state; Apply fires PATCH.
  - `TopToolbar`: "Apply all" count matches dirty buffers; "Apply all" issues PUTs sequentially.
  - `CommentComposer`: send fires POST with the computed anchor (line/col + context).
  - `DiffOverlay`: render hunks → highlight DOM ranges; "Mark as reviewed" fires POST and clears.
  - `UnloadGuard`: dirty buffer + route change → confirm prompt.
- **Manual smoke (Playwright optional, not required for v2):** end-to-end happy path on a dogfood session.

Test files live alongside their packages (`packages/preview/tests/`).

## Effort estimate

| Track | Work | Estimate |
|-------|------|----------|
| Backend | Vite middleware skeleton + body / response helpers | 0.5d |
| Backend | `/api/edit` + atomic write + 409 logic | 0.5d |
| Backend | `/api/status` (both shapes) + `/api/feedback` (POST/GET/PATCH) | 1.0d |
| Backend | `/api/diff` (git invocation + hunk parsing) | 0.5d |
| Backend | `/api/review` + `/api/active-session` (atomic JSON writes) | 0.5d |
| Frontend | rehype source-range plugin + verification | 0.5d |
| Frontend | `EditableBlock` + edit buffer + Apply / Discard + list continuation + serializer | 1.5d |
| Frontend | Status popover (spec-kit changes) + buffer wiring | 0.5d |
| Frontend | Selection → "+" → composer → POST flow (with line/col anchor) | 0.75d |
| Frontend | Comments panel + anchor highlight (line/col + context fallback) | 1.0d |
| Frontend | Diff view overlay + Mark-as-reviewed + top toolbar | 1.0d |
| Frontend | Active-session pinger + unload guard | 0.25d |
| Plugin  | `/synergy-feedback` command + `synergy:address-feedback` skill (with active-session logic) | 0.75d |
| Tests   | Vitest + RTL coverage across the above | 1.5d |

**Total: ~10.75 days.** Parallelizable into 2 sub-agents (backend + frontend) → **~6 days wall clock**, with the skill landing on day 7.

## Open questions

1. **MDX position info granularity.** @mdx-js/rollup carries unified AST positions through the pipeline, but we need to confirm leaf-prose elements retain `position` after MDX → JSX compilation. Spike: a half-day prototype of `rehype-source-range` against `examples/refactor-auth`. If positions are lost, fall back to a remark pre-pass that records source ranges into a side-channel virtual module keyed by block hash.
2. **Phase status storage location.** Today phase metadata lives in `phases/<NN>-<slug>/spec.mdx` frontmatter. Does `status:` belong there too, or in the parent overview's `<Phase status="...">` block? Decision: phase frontmatter is canonical; if a parent overview also has `<Phase status>`, it's denormalized and a `synergy validate` warning. (Resolution of this affects the `/api/status` `phase-frontmatter` shape.)
3. **Anchor context length.** 30 chars before/after is a starting heuristic. May need to grow for repeated short selections ("OK", "X", "and") that don't disambiguate. Could be configurable; v2 ships with 30 fixed and we adjust based on dogfooding.
4. **Apply granularity.** Should there be a "save draft" affordance — buffers that survive a refresh? v2 says no (buffers live in memory only, lost on reload + the unload guard prevents accidental loss). Revisit if dogfooding shows people want to walk away mid-edit.
5. **Diff view + dirty buffers interaction.** Per the spec, diff view disables Apply on dirty blocks while it's open. Alternative: show pending edits as a third color in the diff and allow Apply from inside diff mode. v2 takes the simpler path; revisit.

## Risks

- **Contenteditable quirks.** Paste behavior, IME, undo across save boundaries. Mitigation: aggressive blur-save, explicit `paste` handler that strips formatting, document the known limitations.
- **HMR + editing race.** Vite HMR will reload the source after a save; if the user starts typing again immediately, the contenteditable may be remounted mid-keystroke. Mitigation: the `EditableBlock` keeps focus across remount by `data-block-key` and a `useLayoutEffect` that restores selection.
- **Comment drift in long sessions.** Heavy editing churn → many stale anchors. v2 accepts this; if dogfooding shows it's painful, v2.1 adds light auto-rebase using context fuzzy match.

## What ships in v2

- `packages/preview` gets:
  - `vite-plugin-edit.ts`, `rehype-source-range.ts`
  - `EditableBlock.tsx`, `EditBuffer.ts` (in-memory dirty-state store)
  - `StatusPopover.tsx`
  - `CommentComposer.tsx`, `CommentsPanel.tsx`
  - `DiffOverlay.tsx`, `TopToolbar.tsx`
  - `ActiveSessionPinger.tsx`, `UnloadGuard.tsx`
  - `server/{http,edit,status,feedback,diff,review,active-session,anchor}.ts`
- `packages/spec-kit` gets `editable` + `onChange` on `<Status>` and `<Phase>`. Default render is unchanged so non-preview consumers (if any) are untouched.
- `plugins/claude-code` gets `commands/synergy-feedback.md` and `skills/address-feedback/SKILL.md`.
- `packages/cli/src/init.ts` adds two entries to `GITIGNORE_ENTRIES`: `active-session` and `review-state.json`. (`preview.pid` and `preview.log` stay. `sessions/` and `feedback/` remain tracked — they're the shared spec content.)
- `CLAUDE.md` and `AGENTS.md` get one new section each describing the feedback queue, the Apply/Discard editing surface, and the diff view.
- Tests across all of the above.
