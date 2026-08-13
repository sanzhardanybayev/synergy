# Removal rationale and moved-to navigation

Date: 2026-08-12
Status: approved design, not yet planned

## Problem

In a guided review, a block of removed lines carries no explanation. The reviewer cannot tell
whether the logic was deleted as dead code, folded into another function, or replaced by
something later in the same diff. Answering that question today means leaving the review,
reading the code, and asking the agent - which is the loop the review portal exists to remove.

Two things are missing:

1. **Why** a run of lines was removed.
2. **Where it went**, with navigation, when it moved rather than died.

## Decisions

| Question | Decision |
| --- | --- |
| Granularity | Per contiguous run of removed lines inside a hunk, not per hunk and not per file. |
| Reason shape | A typed category from a closed vocabulary plus one free-text sentence. |
| Reference shape | Authored as a plain `path` + line range. Resolution to an in-review target is derived, never authored. |
| Coverage | Every derived removal run must be covered. `review analysis-set` rejects an incomplete payload. |
| Surfacing | A collapsed one-line strip above each run, expandable to sentence + destination peek. |
| Code font | Out of scope. `--syn-font-mono` stays JetBrains Mono. |

Rejected alternatives, and why:

- **Always-on banner rows.** Zero interaction cost, but a churn-heavy file becomes half prose.
- **Gutter glyph with a hover card.** Zero added density, but invisible until hovered - the
  reviewer must already suspect something to go looking, which is the original problem. Also
  poor in the narrow VS Code panel.
- **A hover-synced side rail.** Leaves the diff untouched but splits attention across panes,
  and the review pane already spends its right side on questions.

## Data model

Added to `packages/review-core/src/types.ts`, with matching validation in `schema.ts`:

```ts
export type RemovalReason =
  | 'moved'
  | 'merged'
  | 'replaced'
  | 'dead-code'
  | 'obsolete'
  | 'extracted-to-dep';

export interface RemovalRunRef {
  path: string;
  start: number;
  end: number;
}

export interface RemovalRationale {
  reviewItemId: string;
  run: RemovalRunRef;
  reason: RemovalReason;
  description: string;
  movedTo?: RemovalRunRef;
}
```

`RemovalRationale[]` becomes an optional `removals` field on `ReviewInsights`, a sibling of
`items` and `files`. `run` uses old-side line numbers; `movedTo` uses new-side line numbers.
`description` reuses the existing insight description length bound.

### Constraints the schema enforces

- `moved`, `merged`, and `replaced` require `movedTo`.
- `dead-code`, `obsolete`, and `extracted-to-dep` forbid `movedTo`.
- `run` must match a derived removal run exactly. A near-miss is a rejection, not a snap.
- `movedTo` must resolve to an existing path and an in-range line span at the captured
  `headSha`. A dangling reference is rejected for the same reason the validator rejects a
  dangling `CrossRef`: a broken jump is worse than no jump.

## Derived removal runs

The CLI derives the canonical run list from the snapshot: within each `DiffHunk`, every
maximal contiguous sequence of `kind: 'remove'` rows is one run, identified by its
`reviewItemId` and its old-side line span. The agent never decides what counts as a run, so
what is gated and what is rendered cannot drift apart.

`review status --json` and `review create --json` expose:

```json
"removals": [
  { "reviewItemId": "hunk-7", "path": "src/auth/session.ts",
    "start": 41, "end": 43, "covered": false }
]
```

Scope reviews contain no removals; the list is empty and the gate is a no-op.

## Reference resolution

Resolution happens at read time in `@synergy/review-core`, in a new `removals.ts`:

- The `movedTo` range is matched against the current snapshot. If it falls inside a captured
  review item, the resolved model carries `targetReviewItemId` plus the matching row ids, and
  the UI renders a clickable jump.
- If it falls outside the review - which is common, because deleted logic often lands in a file
  the diff never touches - the resolved model carries an excerpt read from git at the captured
  `headSha`. The UI renders a read-only peek instead of a jump.

Reading at the captured SHA rather than the worktree keeps the peek exact for an immutable
revision.

## Authoring gate

`review analysis-set` rejects the submitted payload when any derived run is uncovered, when a
`run` does not match a derived run, when the category and `movedTo` presence disagree, or when
`movedTo` fails to resolve. The error names the uncovered runs. `analysisRequired` stays true,
so the portal never opens on a half-explained revision.

The `synergy:review` skill gains a step after grouping: walk the derived runs, inspect each
claimed destination with `git show <headSha>:<path>` to confirm the logic actually landed
there, and only then submit. A `moved` claim that the agent has not verified against the
destination must be downgraded to a category that needs no reference.

## Refresh and carry-forward

On `review refresh`, a rationale carries into the new revision only when its review item
carried forward **and** the run's content hash is unchanged, where that hash covers the exact
removed line texts in order and excludes line numbers, so a pure offset shift still carries.
Otherwise the rationale is dropped and
re-authored. This mirrors `carryForwardFileInsights` in `packages/review-core/src/reconcile.ts`,
which drops a file insight whose underlying items changed rather than leaving it stale.

## Interface

### The strip

A new `RemovalStrip.tsx` in `packages/preview/src/review/`, rendered by `DiffViewer`
immediately above the first removed row of each run.

- Built on native `<details>` and `<summary>`, so keyboard and screen-reader behavior come for
  free and no custom disclosure state exists.
- Collapsed, roughly 22px: caret, category badge, `N lines removed`, and a jump chip when a
  target exists. The two facts needed while scanning - what kind of removal, and where it went -
  stay on screen without interaction.
- Expanded: the sentence, plus the destination peek highlighted through
  `@synergy/review-core/highlight`, keeping that module's rule that every failure path falls
  back to the exact captured text.
- A toolbar `Expand all / Collapse all` control. This is a view preference, not review data:
  it persists in `localStorage` keyed by revision and never touches `progress.json`.
- Styling uses `--syn-*` tokens only. Badge hues come from the existing `--syn-status-*` set and
  the strip ground from `--syn-diff-del-bg`. No new palette values.

### Jump behavior

- An in-review target sets `activeReviewItemId` through the existing provider path, scrolls the
  stage, and flashes the target rows for about 1.2s using the existing `.is-selected` accent
  inset. A back chip naming the origin persists until the next jump or until dismissed.
- A jump never mutates review status and never marks anything reviewed. It may raise the
  walkthrough's local reveal floor so the target is viewable; stored progress is untouched.
- An out-of-review target renders the peek and, in the VS Code host, an `Open in editor` action
  at that range.

### Hosts

Run derivation, resolution, and the strip view-model live in `@synergy/review-core` so the
preview app and `packages/vscode-extension/src/webview/panel.js` render the same model with
host-specific markup. `packages/vscode-extension/media/panel.js` remains a build artifact and is
never edited directly.

## Testing

- **review-core:** run derivation from a snapshot; each schema rejection case; resolution inside
  and outside the snapshot; carry-forward across refresh, both the retained and the dropped path.
- **cli:** the `removals` payload in `status --json`; `analysis-set` rejection listing uncovered
  runs end to end.
- **preview:** one strip per run; expanding reveals the peek; a jump sets the active item and
  flashes the target; the expand-all toggle.

## Release

Behavior changes under `packages/` and `skills/`, so `.claude-plugin/plugin.json` must be bumped
or the CI release gate fails the PR. Derived stamps are written by the `version-sync` hook and
must not be hand-edited.

## Out of scope

- Changing `--syn-font-mono`. Considered and dropped during design.
- Rationale for added or modified lines. Existing per-item insights already cover those.
- Any rationale authoring surface in the browser. The agent authors; the human reads and asks.
