# Review storytelling: guided narrative walkthrough

Date: 2026-08-10
Status: approved design, pending implementation plan

## Problem

A Synergy review currently presents groups, files, and hunks all at once, in whatever
order the analysis payload happened to list them. Descriptions explain each hunk and
file, but nothing tells the reviewer where to start, why a chapter comes next, or what
the overall change is about. For large AI-generated PRs this is overwhelming: the
reviewer may land on a types file or a huge class with no framing.

## Goal

Keep all existing review qualities (grouping, per-hunk and per-file descriptions) and
add storytelling on top:

- A short review-level summary (the global "what and why", 2-4 sentences).
- A deliberate story sequence: chapters (groups), then files within a chapter, then
  hunks within a file, ordered so understanding builds gradually.
- A paced-reveal UI that walks the reviewer chapter by chapter, page by page, while
  always allowing free navigation and a "reveal all" escape hatch.

Applies to both diff reviews (PR, staged, unstaged) and scope reviews, and to both
surfaces: the web preview portal and the VS Code extension pane.

## Approach (chosen)

Narrative text plus deliberate array order plus a walkthrough UI. No numeric ordering
fields: ordering in the persisted analysis is already purely positional and both UIs
already render arrays in order. The agent authors the story by ordering the arrays and
writing two new optional text fields. Rejected alternatives: explicit `storyOrder`
numeric fields (redundant with array order, three validation layers to keep
consistent) and a separate `story.json` artifact (two sources of truth, extra command
surface, cross-artifact validation).

## 1. Data model and schema

All additions are optional properties at `schemaVersion: 1`. No migration; revisions
without the new fields render exactly as today.

Analysis input (`packages/cli/src/review-analysis.schema.json` and the strict parser
in `packages/cli/src/review-analysis.ts`):

- Root: `summary` - string, 1-600 chars, trimmed non-blank. Optional in schema;
  the skill instructs the agent to always provide it.
- `diffGroup` and `scopeGroup`: `intro` - optional string, 1-300 chars, trimmed
  non-blank. One or two sentences: why this chapter comes now and what to look for.

Story sequence is array order, which is already the render order everywhere:

- `groups[]` order = chapter order.
- `group.reviewItemIds[]` (diff) or `group.sectionKeys[]` (scope) order = page order.
  File sequence within a chapter is first-appearance order of paths in that list;
  hunk sequence within a file is the position of that file's items in the list.

Persisted shape (`packages/review-core/src/types.ts`, ajv in
`packages/review-core/src/schema.ts`): mirror `summary?` on `ReviewInsights` root and
`intro?` on the persisted group. `review analysis-set` copies both through in the diff
and scope paths (`packages/cli/src/review-actions.ts`). `bundle.json` picks them up
automatically because it embeds insights.

Semantic validation: trim and length caps only. Ordering needs no new validation;
group ownership and uniqueness of item references are already enforced.

## 2. Skill and authoring changes (`skills/review/SKILL.md`)

Step 3 gains a narrative-ordering contract:

- Plan the story before writing the payload. Start with the entry point that frames
  the change (behavior, API, user-visible surface), not types or plumbing first, not
  alphabetical order. Each chapter builds on the previous ones; dependencies and types
  appear when the reader first needs them.
- `summary`: 2-4 sentences covering what the change does, why, and the route the
  review will take ("first X, then Y, finally tests"). Hard cap 600 chars.
- Per-group `intro`: 1-2 sentences written as a hand-off from the previous chapter:
  why this chapter now, what to check.
- Explicit rule: array order is the walkthrough order for chapters, files
  (first appearance), and hunks within a file. Order `reviewItemIds` / `sectionKeys`
  deliberately.
- Big-unit exception: when one large class or module genuinely is the right starting
  point, lead with it and say so in its intro. The default remains gradual buildup.
- The example payload in the skill is updated with `summary` and `intro`.

This is a behavior change under `skills/` and `packages/`, so the plugin version in
`.claude-plugin/plugin.json` must be bumped; lefthook `version-sync` derives the
stamps.

## 3. Web preview walkthrough (`packages/preview/src/review/`)

- Story header: `summary` rendered at the top of the stage, always visible. Quiet
  typography using theme tokens; no hardcoded palette values.
- Paced reveal: a walkthrough cursor records the furthest-revealed position (chapter
  index plus item index). Chapters past the cursor appear in the sidebar as dimmed
  titles (locked look, still clickable). The stage shows the current chapter's
  `intro`, then its pages in story order. A Continue control at the end of each
  chapter reveals and scrolls to the next chapter. Within a chapter, items advance
  with the existing J/K navigation plus Continue.
- Free navigation: clicking any sidebar entry navigates there and advances the reveal
  cursor to cover it. Reveal is monotonic - nothing is ever re-hidden. A "Reveal all"
  affordance in the header shows the full map immediately.
- Ordering source: no new sort logic. `orderedItems` in `ReviewShell.tsx` already
  flattens the groups' `reviewItemIds`. Hunk tabs reorder to story order; tab labels
  keep a line-range hint so out-of-line-order hunks stay legible.
- Feature detection: walkthrough mode is the default when `summary` is present.
  Revisions without narrative fields render exactly today's UI.
- Persistence: the reveal cursor is stored in the existing, currently unused
  `ReviewProgress.activeGroupId` / `activeReviewItemId` (and `activeFile`) fields via
  the widened progress PATCH endpoint. It survives reload and syncs across clients
  over the existing progress SSE frames.

## 4. VS Code pane (`packages/vscode-extension`)

- `media/panel.js` renders a `summary` card at the top and the per-group `intro` line
  under each group header.
- Same paced reveal: groups past the cursor are collapsed and dimmed showing only the
  title; a Continue control at the end of each group's item list expands the next.
  Click-to-jump advances the cursor (monotonic). "Reveal all" lives in the pane
  toolbar.
- The cursor is shared with the web preview: read and write the same
  `ReviewProgress.active*` fields through a review-core store helper
  (`patchWalkthroughPosition`, alongside `setItemStatus`). The existing fs watcher and
  daemon SSE link re-post the bundle, keeping both surfaces in sync.
- No narrative fields means the current flat rendering, unchanged.

## 5. API and store plumbing

- review-core store: new `patchWalkthroughPosition(ws, rev, {activeGroupId?,
  activeReviewItemId?, activeFile?})` writing `progress.json` atomically. Field
  validation already exists in the progress schema.
- Preview server: the PATCH `/api/reviews/:ws/:rev/progress` handler accepts the
  optional `active*` keys next to `{status, note}` and broadcasts them in the
  existing progress SSE frame.
- Monotonicity is enforced store-side: an incoming position earlier than the stored
  one (compared via the story order derived from the insights arrays) is ignored.
  Both UIs stay simple and cannot regress each other's cursor.

## 6. Error handling

- Parser rejects blank or over-length `summary` / `intro` with the same corrective
  error style as existing fields; unknown keys remain rejected.
- A walkthrough position referencing a group or item that does not exist in the
  revision is rejected by the store (existing relationship validation).
- Preview and pane treat missing narrative fields as "no walkthrough" rather than an
  error state.

## 7. Testing

- CLI: parser accept/reject cases for `summary` and `intro` (length, blank, unknown
  keys still rejected); the schema-agreement test extends automatically; persistence
  round-trip for diff and scope payloads.
- review-core: ajv insight schema cases; unit tests for walkthrough patch
  monotonicity and relationship validation.
- Preview: vitest component tests for feature-detect fallback, reveal progression,
  and jump-ahead advancing the cursor.
- VS Code: provider suite extended for summary/intro serialization and position
  messages.
- End to end: `review-e2e.test.ts` extended - analysis with narrative fields is
  finalized, the bundle exposes them, and the progress PATCH round-trips the cursor.

## Out of scope

- Multiple alternative stories per revision.
- Re-hiding revealed chapters or non-monotonic cursors.
- Narrative for the review index page.
- Any change to question/answer flow, reconciliation, or readiness rules.
