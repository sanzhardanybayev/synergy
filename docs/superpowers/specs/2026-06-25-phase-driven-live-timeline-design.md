# Phase-driven live timeline

**Status:** Design approved · 2026-06-25
**Author:** Sanzhar (via brainstorming)

## Problem

The overview timeline does not update as a session is implemented. The right-rail
progress drawer reflects phase status (it polls `/api/progress`), but the `<Timeline>`
in the overview renders a hand-authored milestone list with static `status` props that
never track execution. The result: a user watching the preview sees the drawer move but
the timeline sit still, and the two surfaces drift apart.

Root causes:

1. **`<Timeline>` is static.** Unlike `<Phase>` (which calls `useExecutionState()` and
   renders `effectiveStatus = live.status ?? authored`), `Timeline.tsx` reads milestone
   `status` props directly and never consults execution state.
   (`packages/spec-kit/src/components/Timeline.tsx`)
2. **The roster is incomplete.** `emptyProgress()` seeds `phases: []`, and
   `setPhaseStatus` only *adds* a phase the first time it is touched. So
   `deriveProgress` computes `total = phases-touched-so-far`, not the true phase count —
   an honest "3/5" bar is impossible early in a run (it reads 1/1 = 100%). The right rail
   shares this gap: it only lists touched phases, with no titles and no ordering.
   (`packages/state/src/progress.ts`, `packages/state/src/mutations.ts`)
3. **Updates are slow.** `ProgressProvider` polls every 4s, so a phase flip lags.
   (`packages/preview/src/ProgressProvider.tsx`)

## Goals

- The overview timeline **is** the implementation steps (the phases), driven live by the
  same execution-state source the right rail uses — a single source of truth, never
  diverging.
- Each step shows **number + human title + live status** (e.g. `● 3  Cutover to new
  store  in-progress`), with a derived progress bar on top.
- Phase status changes appear **near-instantly** in the preview (push, not slow poll).
- No new skill. Existing skills + validator enforce that status-bearing components are
  live-bound and that planning needs no extra write step.

### Out of scope

- Rewriting `.mdx` files to persist status (rejected: contradicts the static-MDX /
  dynamic-state split; live overlay chosen instead).
- Per-milestone `phase=` linkage or mixed phase+milestone timelines (rejected: phases are
  the whole timeline).
- A browser "confirm it rendered" verification step in the execute loop (not requested).
- A dedicated `phase sync` CLI/API to seed the roster (eliminated — `total` derives from
  phase folders on disk instead of being written into `progress.json`).

## Design

### Foundation — one enriched roster feeding both surfaces

`GET /api/progress?session=` (in `packages/preview/src/server/progress.ts`) returns a new
ordered **roster** in addition to its current payload:

```ts
roster: Array<{ number: number; slug: string; title: string; status: StatusValue }>
```

- `number`, `slug`, `title` ← scanned from each `phases/<NN>-<slug>/spec.mdx` frontmatter
  (`order` / numeric folder prefix for `number`, folder slug for `slug`, `title` for the
  label). Sorted by `number`.
- `status` ← merged live from `progress.json` by slug; defaults to `proposed` for phases
  not yet touched.
- `total` = roster length (derived from folders — self-correcting when folders are
  added/removed/renamed); `done` = roster entries whose status is in the done/shipped set.
  `deriveProgress`'s `total` is sourced from the roster, not `progress.json.phases.length`.

This roster is the single source of truth. **Both** `<Timeline>` and the right-rail
`ProgressDrawer` render from it, so they cannot diverge. This also upgrades the right rail:
it will show *all* phases (with titles and ordering), not only touched ones.

`progress.json` is unchanged on disk — it stays lazy and status-only. No planning-time
write is introduced.

### Part A — `<Timeline>` becomes a live phase tracker

The execution-state context (`packages/spec-kit/src/ExecutionState.tsx`, surfaced through
`packages/preview/src/ProgressProvider.tsx`) is extended to carry `roster` and `derived`
alongside the existing `phases` map.

`Timeline.tsx`:

- When no `milestones` prop is given (the phase-driven form), it reads `roster` + `derived`
  from context and renders: a derived progress bar, then one step per roster entry —
  `<status dot> <number>  <title>  <status>`. Steps and titles come from the roster, never
  from the doc, so they never drift.
- When `roster` is empty (e.g. a tiny session with no phase folders, or no execution
  state), it renders nothing.
- The legacy `<Timeline milestones={...}>` form is retained unchanged for pure-documentation
  timelines, but the scaffolded template uses the phase-driven form.

Author writes just `<Timeline />` in the overview.

### Part B — Instant updates (SSE, poll fallback)

A new SSE endpoint `GET /api/progress/stream?session=` in the preview server `fs.watch`es
the session's `.state/` directory (status flips) and `phases/` directory (roster changes),
and pushes the fresh roster payload on any change.

`ProgressProvider` subscribes via `EventSource` and updates on push; if the stream errors
or closes it falls back to the existing poll. Because both the timeline and the right rail
share this provider, a `phase set` during execution moves the bar and flips the step on
both surfaces near-instantly.

### Part C — The guarantee (enhance existing skills + validator; no new skill)

- **Live-bound convention** — documented in `CLAUDE.md` and the `spec-authoring` skill:
  status-bearing spec-kit components must consume execution state, never hardcode status.
  `<Timeline>` now complies by construction; `<Phase>` already does.
- **create-spec** — the overview template ships `<Timeline />` (phase-driven). No seed or
  sync step is needed because `total` derives from the phase folders.
- **execute** — the mandatory write-gate is unchanged: it already writes phase status at
  each boundary, which is exactly what drives the live updates.
- **Validator** — warn when a `phases/<NN>-<slug>/spec.mdx` lacks a `title` (the timeline
  step label needs it). Keep the existing `<Phase>`-missing-`id` warning.

## Components and boundaries

| Unit | Responsibility | Depends on |
|---|---|---|
| `server/progress.ts` (roster builder) | Scan phase folders, merge live status, return ordered roster + derived totals | phase-folder frontmatter, `progress.json` |
| `server/progress.ts` (SSE stream) | Watch `.state/` + `phases/`, push roster on change | `fs.watch`, roster builder |
| `ProgressProvider` | Subscribe via SSE (poll fallback), feed context | `EventSource`, `/api/progress*` |
| `ExecutionState` context | Carry `phases`, `roster`, `derived` | — |
| `Timeline` | Render bar + phase steps from context (phase-driven); legacy milestone mode | execution-state context |
| `ProgressDrawer` | Render right rail from the shared roster | execution-state context |
| Validator | Warn on phase `spec.mdx` missing `title` | phase-folder frontmatter |

## Data flow

```
phases/<NN>-<slug>/spec.mdx  ──┐
                               ├─► server roster builder ─► /api/progress (+ /stream SSE)
.state/progress.json  ─────────┘                                   │
                                                                   ▼
                                            ProgressProvider (EventSource, poll fallback)
                                                                   │
                                                ExecutionState context {phases, roster, derived}
                                                          │                         │
                                                   <Timeline/> (bar + steps)   ProgressDrawer (right rail)
```

`execute` skill `phase set` → writes `.state/progress.json` → `fs.watch` fires → SSE push →
both surfaces update near-instantly.

## Error handling

- **Missing/garbled phase frontmatter** → that phase still appears in the roster with a
  fallback title (slug) and `proposed` status; validator emits the missing-`title` warning.
- **Slug renamed after a phase was marked done** → the done status orphans (slug mismatch)
  and the phase reverts to `proposed`. Accepted tradeoff; slugs are the stable identity and
  renaming them is already discouraged.
- **SSE unavailable / dropped** → `ProgressProvider` falls back to the existing poll; no
  loss of correctness, only of instant-ness.
- **No phase folders** → empty roster; `<Timeline />` renders nothing; bar hidden.

## Testing

- **Endpoint:** roster built from folders + merged live status; correct `total`/`done`;
  untouched phases present as `proposed`; missing-frontmatter fallback.
- **Component:** Timeline renders ordered steps + bar from context; empty roster renders
  nothing; legacy `milestones` path still works.
- **SSE:** a `.state` write pushes an event and the provider updates without a poll; stream
  close triggers poll fallback.
- **Validator:** phase `spec.mdx` missing `title` warns.

## Risks

- **Right-rail appearance change.** Showing all phases (with titles) changes the drawer's
  current look. Accepted — it's the consistency win that makes the two surfaces share a
  source.
- **SSE is the one net-new moving part.** Fallback to a ~1s poll exists if streaming proves
  fragile; correctness does not depend on SSE.
