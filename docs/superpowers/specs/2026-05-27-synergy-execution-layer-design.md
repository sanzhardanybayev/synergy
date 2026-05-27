# Synergy Execution Layer — Design

**Date:** 2026-05-27
**Status:** Approved (brainstorm complete, pending implementation plan)
**Target:** Synergy v0.3

## Problem

Synergy today is excellent at **authoring a plan** but has no concept of **execution
state** — the running record of what an implementing agent has done, what is in flight,
and what a fresh agent needs in order to continue.

Observed pain when agents implement a session:

1. Finishing a phase does not flip that phase's status.
2. The overview never reflects overall progress ("halfway through").
3. `<Phase>` status badges exist in the component API but are not authored or updated.
4. There is no place for an agent to record findings, so clearing the session and
   handing off to a fresh-context agent loses everything the previous agent learned.

The goal is a second lifecycle layered on top of authoring: a **glanceable progress
surface** for the human, and a **resumable hand-off record** for fresh-context agents —
without conflating "the plan" with "what actually happened."

## Core idea

The spec MDX stays the **plan** (agents stop hand-editing status into it). A sidecar
`.state/` directory is the **running record**. The preview overlays live state onto the
rendered spec. Plan and record-of-what-happened stay distinct.

## Decisions (locked during brainstorm)

| # | Decision |
|---|----------|
| 1 | State lives in a **separate execution layer** feeding a **dedicated surface**, not scattered in prose. |
| 2 | Log model is **checkpoint + findings**: a required terse boundary note per phase, plus optional ad-hoc findings. |
| 3 | Updates are driven by an **execution skill that owns the loop**, with a mandatory state-write gate. Writes go through a thin CLI for determinism. |
| 4 | Display is **both**: inline live badges on each `<Phase>` *and* a triggered right-rail Progress drawer. |
| 5 | State is **both per-phase and global**: per-phase status + journals are the source of truth; the global layer is a derived rollup + resume pointer + a cross-cutting log (no duplicated data). |
| 6 | Fan-out metadata (model / effort / count) lives **on `<AgentAllocation>`** in the plan. |
| 7 | A bespoke model-pinned execution **agent type is deferred** to a later release. |

## Components of the design

### 1. Stable phase identity (prerequisite)

`<Phase>` gains a stable `id` (slug). All execution state keys on `<session>/<phaseId>`,
so renumbering (`number`) or retitling never breaks the link.

- Folder-based phases (`phases/<NN>-<slug>/`) use their folder slug as `id`.
- Inline `<Phase id="storage" number={1} ...>` declares it explicitly.
- If `id` is omitted, it is derived from the title slug, and the **validator emits a
  warning** prompting the author to make it explicit.

This extends the principle CLAUDE.md already states for phase folders ("the slug is the
stable identifier; renumbering does not break cross-refs") to inline phases.

### 2. Data model — `.state/` (committed to git)

```
.synergy/sessions/<session>/
  00-overview.mdx             # plan — unchanged by execution
  02-implementation.mdx       # plan — <Phase id="storage" ...>
  orchestrator.md             # static strategy + one "live progress" pointer line
  .state/
    progress.json             # phase statuses + timestamps + resume pointer (= global state)
    phases/<phaseId>.md        # per-phase journal: boundary note(s) + ad-hoc findings
    journal.md                # global cross-cutting findings only (= global log)
```

`progress.json` shape:

```jsonc
{
  "overallStatus": "in-progress",      // authored; may override the derived rollup
  "resume": {                          // FIRST thing a fresh agent reads
    "nextPhase": "cutover",
    "note": "Phase 1 done; baseline p95 in metrics.json. Begin canary at 1%."
  },
  "phases": [
    { "slug": "storage", "status": "done",        "startedAt": "...", "completedAt": "..." },
    { "slug": "cutover", "status": "in-progress", "startedAt": "..." },
    { "slug": "cleanup", "status": "draft" }
  ]
}
```

Rules:

- **Per-phase status + per-phase journals are the source of truth.**
- **Overall progress % is always derived** from `phases[].status` — never stored, so it
  cannot drift.
- `resume` is the hand-off primitive a fresh agent reads first.
- `journal.md` is *only* for findings that span phases (e.g. "auth cache TTL is
  undocumented = 300s, affects every phase"). Per-phase logs remain the backbone — no
  double-logging.
- `.state/` is **tracked in git** (unlike per-user `review-state.json`): it is the shared
  hand-off record that a fresh clone/context depends on.

### 3. Write path — thin CLI

```
synergy phase set <session> <phaseId> <status> [--note "boundary note"]
synergy log  <session> <phaseId> "finding"        # ad-hoc per-phase finding
synergy log  <session> --global "finding"         # cross-cutting finding
synergy resume <session> --next <phaseId> --note "start here"
synergy status <session>                           # prints the rollup (terminal hand-off)
```

The CLI is the single audited write path. It guarantees valid schema, stamped
timestamps, and correctly-derived progress — the thing that makes "the agent reliably
updates state" true instead of aspirational. Agents do **not** hand-edit `.state/` JSON.

### 4. Discipline — `synergy:execute` skill owns the loop

A new skill drives implementation and makes the state write a hard gate:

1. Read `orchestrator.md` + `synergy status <session>` (current state).
2. Pick next phase → `synergy phase set <id> in-progress`.
3. Implement; drop `synergy log` findings as discoveries happen.
4. Run the phase's verification gate.
5. **[MANDATORY checklist gate]** write the boundary note + `synergy phase set <id> done`
   + `synergy resume --next <nextId>` — *before* moving on.
6. Human checkpoint → next phase.

### 5. Hand-off — `/synergy-resume` skill (fresh-context entry point)

A fresh agent runs `/synergy-resume <session>`. Read order is **state first, strategy
second, plan-detail third**:

1. `synergy status <session>` → rollup + resume pointer.
2. `.state/phases/<nextPhase>.md` (and prior boundary notes) + `.state/journal.md`.
3. `orchestrator.md` (strategy) + the relevant phase `spec.mdx`.
4. Continue from exactly where the previous agent stopped.

### 6. Skills accept run-time directives

Both `synergy:execute` and `synergy:resume` take free-form args after the session. The
skill resolves the **session** first (falling back to `active-session` if omitted, like
the feedback flow), then treats the **rest as run-time directives layered above the
plan**:

```
/synergy-execute refactor-auth  but only do Phase 1, stop before cutover
/synergy-execute refactor-auth  use sonnet for the sub-agents this run
/synergy-resume  refactor-auth  the canary half-failed last night, re-verify P2 first
```

Directives can scope the run, **override the plan's fan-out metadata for this run only**,
or inject fresh real-world context.

**Guardrail:** directives affect *the run*, not the *stored plan/state*. "Use sonnet this
run" does not rewrite `<AgentAllocation>`; it only changes how this execution fans out.
State writes still reflect what actually happened. The plan stays stable.

### 7. Display (preview)

- **Inline live badges** on every `<Phase>`: status comes from `.state` (overriding the
  authored prop), plus a one-line "latest findings" peek.
- **Triggered right-rail Progress drawer** (toolbar toggle): derived progress bar,
  per-phase status list, expandable per-phase journals, and the global cross-cutting log.
- An **`ExecutionStateProvider`** loads `progress.json` + journals and feeds both
  surfaces. It hot-reloads on `.state/` changes, the same way MDX hot-reloads today.

The authored `status` prop = the initial plan; live `.state` = current truth. The badge
always shows live truth.

### 8. Fan-out metadata on `<AgentAllocation>`

Each entry gains optional `model`, `effort`, and `count`, so the plan is self-describing
for deterministic fan-out:

```jsx
<AgentAllocation entries={[
  { name: 'storage-impl',  type: 'sub-agent',  phases: ['storage'], model: 'opus',   effort: 'high', count: 2 },
  { name: 'migration-team', type: 'agent-team', phases: ['cutover'], model: 'opus',   effort: 'max' },
  { name: 'audit-prep',    type: 'sub-agent',  phases: ['cleanup'], model: 'sonnet', effort: 'medium' },
]} />
```

`synergy:execute` reads these as the **defaults** for fan-out; inline run directives win
over them for a given run. These are the determinism lever — not a bespoke agent.

## Out of scope (this release)

- A bespoke model-pinned execution **agent type**. The skill + fan-out metadata + CLI give
  the deterministic fan-out without it; revisit after dogfooding.
- Auto-mutating `orchestrator.md` into a live dashboard. It stays static strategy with one
  pointer line to where live state lives.
- Codex distribution (already excluded from v1 per CLAUDE.md).

## Affected packages

- `packages/spec-kit` — `<Phase id>`, `ExecutionStateProvider`, badge/findings-peek
  rendering, Progress drawer, `<AgentAllocation>` fan-out fields, updated schemas.
- `packages/validator` — phase-id presence/uniqueness warning, `.state/` ↔ spec
  cross-check (state phase slugs must exist in the spec), `progress.json` schema check.
- `packages/cli` — `synergy phase`, `synergy log`, `synergy resume`, `synergy status`.
- `packages/preview` — wire `ExecutionStateProvider`, drawer UI, `.state/` watch + hot
  reload.
- `plugins/claude-code` — `synergy:execute` + `synergy:resume` skills and slash commands;
  AGENTS.md protocol notes.

## Success criteria

1. An implementing agent flips each phase to `done` and writes a boundary note without
   being reminded (skill gate enforces it).
2. The overview/drawer shows correct derived progress that never drifts from phase status.
3. A fresh-context agent given only `/synergy-resume <session>` continues from the right
   place using the resume pointer + journals.
4. Phase identity survives renumbering/retitling.
5. The plan's fan-out metadata deterministically configures sub-agent/team spawning, and
   run directives override it for a single run without mutating the plan.
