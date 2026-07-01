# Design: Session Knowledge-Transfer (KT) Handoff Data

**Status:** APPROVED (decisions locked autonomously per user's "work until done" directive; revisit on request)
**Date:** 2026-07-02
**Author:** Synergy team
**Related:** execution-state resume (`packages/state`), `synergy:execute`, `synergy:continue`

---

## Problem

A user works a Synergy session for a while, then needs to stop and close their
laptop — often **mid-phase**, not at a clean phase boundary. Today the only durable
hand-off records are:

- `progress.json` `resume` pointer (`nextPhase` + free-text `note`) — written **only at
  phase gates** by the `execute` skill's mandatory close-out step.
- `.state/journal.md` (global findings) and `.state/phases/<slug>.md` (boundary notes) —
  append-only, written by `log` / `phase set --note`.

Two gaps make the "close laptop mid-work and hand off" scenario unreliable:

1. **No mid-phase capture trigger.** There is no way to say "snapshot everything I know
   right now" between phase gates. If work stops mid-phase, the phase stays `in-progress`
   with no note, and a re-run redoes it from scratch (the Q2 mid-phase blind spot).
2. **Inconsistent ingestion.** `continue` reads the resume pointer + journals first, but
   `execute` does **not** — it reads status → orchestrator → spec. So whether the prior
   agent's knowledge is honored depends on which entry point the next agent uses.

The user's requirement, verbatim in intent: *the hand-off must let another agent pick up
the work when I exit the session, and it must be taken into account when agents **start**
their work.*

## Goal

Let the current live agent — which already holds the full working context — capture a
knowledge-transfer snapshot **on demand at any point**, and guarantee the **next** agent
ingests it **before touching code**, regardless of entry point.

## Non-goals

- Reading/parsing the raw Claude Code conversation transcript. The live agent authors the
  snapshot from its own context; we do not scrape harness internals.
- Structured/typed KT fields. The snapshot is free-form markdown — a brain-dump resists
  rigid schemas.
- Solving the Q1 agent-spawn wiring (AgentTree → real Agent/Workflow tool calls, `effort`
  routing, `team` semantics). That is a **separate** feature; noted here only because a
  richer hand-off makes a resumed run more effective once spawning is real.

---

## File roles (non-overlapping) — what KT *is*

Knowledge transfer = **handoff (orientation) + journals (history)**, read together. Clean,
non-overlapping roles:

| File | Role | Write mode | Written by | Read when |
|---|---|---|---|---|
| `.state/journal.md` | Durable **history** — cross-cutting findings over time | **append** | `log --global` during work | context / backstory |
| `.state/phases/<slug>.md` | Durable **history per phase** — boundary notes + findings | **append** | `phase set --note`, `log --phase` | resuming a phase |
| `.state/handoff.md` | Volatile **"now" baton** — current state + next concrete step | **overwrite (latest-wins)** | `/synergy-handoff` on quit | **FIRST, always** |

The handoff is the single "you are here" pin; the journals are the append-only backstory.
They do not duplicate: the handoff is *this moment's snapshot* (overwritten each capture),
the journals are *what happened over time* (never lost). The resume run reads the handoff
first for orientation, then the journals for detail.

## Approach (chosen: dedicated latest-wins baton file)

Add a thin, git-committed **`.state/handoff.md`** per session: the single "current baton."
It is **latest-wins** (each capture overwrites it), so the next agent has exactly one
unambiguous place to read "where the last agent left off." Append-only history stays in
`journal.md`; `handoff.md` is the volatile current state on top of it.

Rejected alternatives:

- **A — Journal-only.** Append a `## HANDOFF` block to `journal.md` and patch `execute` to
  read it. Zero new artifacts, but "latest handoff" must be grepped out of a growing log
  and `resume.note` is clobbered at every gate. Kept as the fallback if the user vetoes a
  new file.
- **C — Structured resume-pointer fields.** Rigid, historyless, and a free-form dump does
  not fit fixed fields.

### Why a new file beats reusing `journal.md`

The entire value the user asked for — "agents take it into account when they start,
most importantly at start" — hinges on a **guaranteed, unambiguous first read**. A
dedicated file makes "read `handoff.md` first" a one-line, non-negotiable contract in both
skills. Grepping the latest block out of an append-only journal is fragile by comparison.

---

## Components

### 1. `packages/state` — persistence primitives

- `paths.ts`: add `handoffPath(sessionDir) → .state/handoff.md`.
- New `handoff.ts`:
  - `writeHandoff(sessionDir, body: string, now?)` — atomic write (tmp + rename, mirroring
    `writeProgress`), overwriting any prior file. Prepends a `# Handoff — <ISO timestamp>`
    heading so freshness is visible.
  - `readHandoff(sessionDir): string | null` — returns file contents or `null` if absent.
- `index.ts`: export both + `handoffPath`.
- The hand-off **also** touches the resume pointer: capture sets
  `resume.nextPhase` (the phase in progress, or the next one) and a short
  `resume.note` = `"See .state/handoff.md (captured <ts>)"`. This keeps the existing
  pointer honest and points at the rich dump without bloating `note`.

### 2. `packages/cli` — `synergy handoff` verb

```
synergy handoff <session> [--next <phaseId>] [--body <text> | --body-file <path>]
```

- Writes `handoff.md` via `writeHandoff`, then updates the resume pointer via the existing
  `setResume` path.
- Follows the established `tryDaemon(...) → fallback` pattern: prefer `POST /api/handoff`,
  fall back to direct state write on `ECONNREFUSED`.
- In practice the skill passes the authored markdown via `--body-file` (a temp file) to
  avoid shell-escaping a large multi-line dump.

### 3. Daemon — `POST /api/handoff`

- Body: `{ session, body, next? }`. Writes the same `handoff.md` + resume pointer the CLI
  does (warm-process fast path, consistent with the existing `/api/phase|log|resume` table
  in CLAUDE.md).
- Add the row to the CLAUDE.md daemon-API table.

### 4. Skill + command — `synergy:handoff` / `/synergy-handoff`

New skill the user runs when quitting. It:

1. Resolves the session (args → `.synergy/active-session`, same as `execute` step 1).
2. **Self-authors** the snapshot from its own live context into a fixed template (below).
3. Writes it via daemon (`POST /api/handoff`) or CLI fallback.
4. Confirms the file path + resume pointer back to the user, then it is safe to quit.

**Handoff template** (the agent fills every section; "none" is a valid value):

```markdown
## What I did this session
## In-flight / half-done   (files touched but not complete; what's missing)
## Next concrete step       (the single first action the next agent should take)
## Gotchas / dead-ends      (what NOT to retry, surprising constraints)
## Open questions           (decisions deferred to a human)
## Current phase state      (phaseId + rough %; e.g. "storage ~60%")
```

The "Current phase state" + "In-flight" sections are exactly what closes the mid-phase
blind spot: they carry sub-phase progress the phase-gated journals never captured.

**Reference phases by slug, never by file path.** "Current phase state" names the phase
**slug** (e.g. `storage`), not a path like `phases/01-storage/spec.mdx`. Paths rot under
renumbering — the numeric prefix is sort-order, not identity (per the project's cross-ref
rule). The resuming agent resolves the spec/orchestrator paths from the slug via the fixed
layout convention; the handoff carries **knowledge + slug**, no embedded file links.

### 5. Tiered ingestion — patch both entry skills

Both entry points read **lazily**, in tiers, so the opening context stays small. The
handoff is the cheap orientation layer; everything else is pulled on demand:

| Tier | File(s) | When | Why |
|---|---|---|---|
| **Always, first** | `handoff.md` | every resume | the router — where am I, next step, current phase slug |
| **Always** | resume pointer / `status` | every resume | confirms `nextPhase`; tiny |
| **Conditional** | `phases/<slug>.md`, `journal.md` | only when the handoff routes you into a phase needing backstory | history behind the snapshot |
| **Lazy** | `spec.mdx` (one phase) | only at implement-time, after a phase is picked | the biggest reader — never front-loaded |
| **On-demand** | `orchestrator.md` | only when strategy / dep-graph is needed | avoids upfront strategy dump |

- **`continue` skill:** add `handoff.md` as the **first** read in step 2 (before resume
  pointer + journals). Minimal change — it already reads state-first and already scopes the
  spec to the resume phase.
- **`execute` skill:** in step 2 ("Read state first"), add `handoff.md` as the **first**
  read, then a rule: *if a handoff names an in-progress phase, resume that phase from its
  "Next concrete step" rather than restarting it.* Pull `phases/<slug>.md` + `journal.md`
  **conditionally** (when the handoff routes you into a phase needing backstory), not
  unconditionally. This is the key fix — `execute` today ingests **neither** the handoff
  nor the journals. KT = handoff + journals; execute must be able to reach both, lazily.
- **Preserve lazy spec reads.** Both skills already read only the **relevant** phase's
  `spec.mdx`, never all phases, and only at implement-time. State this explicitly so it is
  not "improved" into an upfront read. The handoff routes; the spec is pulled per-phase
  when work on that phase starts.
- Both skills: after a successful resume the stale `handoff.md` is left in place (it is
  overwritten by the next capture); it is **not** auto-deleted, so it survives a crash of
  the resuming agent too.

---

## Data flow

```
Quitting:
  user runs /synergy-handoff <session>
    → live agent writes snapshot markdown (its own context)
    → POST /api/handoff {session, body, next}   (or CLI fallback)
      → writeHandoff(.state/handoff.md)   [atomic, latest-wins]
      → setResume({nextPhase, note:"see handoff.md"})
    → agent confirms path; user quits

Resuming (either entry point):
  /synergy-continue or /synergy-execute <session>
    → read .state/handoff.md FIRST   ← new mandatory step
    → read resume pointer + journals + orchestrator + spec
    → if handoff names in-progress phase: resume mid-phase from "Next concrete step"
    → run execute loop
```

`handoff.md` is git-committed alongside the rest of `.state/`, so the baton travels with
the repo across machines/agents — same durability guarantee as `progress.json`.

## Error handling

- **No handoff present:** `readHandoff` → `null`; skills proceed exactly as today (pure
  additive behavior, fully backward compatible).
- **Daemon down:** CLI/skill fall back to direct state write (`ECONNREFUSED`), same pattern
  as every other state mutation.
- **Stale handoff after a completed resume:** acceptable — it is overwritten on the next
  capture. Skills should note in their output when they are acting on a handoff whose
  timestamp is older than the newest phase-journal entry, so a resuming agent can sanity-
  check freshness.
- **Concurrent captures:** atomic tmp+rename makes last-writer-wins safe; no partial files.

## Testing

- `packages/state`: unit tests for `writeHandoff` (atomic overwrite, heading/timestamp),
  `readHandoff` (present / absent), and that capture updates the resume pointer without
  clobbering unrelated fields (mirror `execstate.test.ts`).
- `packages/cli`: `synergy handoff` writes the file + pointer; `--body-file` path; daemon
  fast-path vs fallback selection.
- Daemon: `POST /api/handoff` writes identical bytes to the CLI path (parity test).
- Skills: manual dogfood in `examples/` — capture mid-phase, then `continue` and confirm
  the resumed agent reads `handoff.md` first and does not restart the in-progress phase.

## Release / freshness

- Behavior change under `skills/`, `packages/`, `commands/` → **must bump**
  `.claude-plugin/plugin.json` `version` (release-gate CI). Bump the `synergy-version`
  markers via lefthook `version-sync` — never hand-edit.
- New command `/synergy-handoff` registered in the plugin manifest + CLAUDE.md command
  list; new daemon row added to the CLAUDE.md daemon-API table.

## Locked decisions (revisit on request)

- **Dedicated `handoff.md`** (over journal-only). A guaranteed unambiguous first-read is the
  whole point; approach A (journal-only) remains the documented fallback if a new artifact
  is later deemed unwanted.
- **Capture mode: agent self-authors on command.** Lowest friction for the "close laptop
  and go" scenario; the live agent already holds the context. Draft-then-edit can be added
  later as a `--review` flag on `/synergy-handoff` without changing the data model.
```
