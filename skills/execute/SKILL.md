---
name: execute
description: Use when the user runs /synergy-execute or asks Claude to implement a Synergy spec session phase by phase. Owns the disciplined execution loop — reads orchestrator + live .state, works one phase at a time, and writes a boundary note + flips phase status via the synergy CLI before moving on. Honors run-time directives (scope, model/effort overrides) layered above the plan.
---

<!-- synergy-version: 0.15.0 -->

## Step 0 — Freshness check (run before anything else)

This skill loads at session start, so it can be **stale** if the plugin was updated
mid-session. Before doing any work, confirm you are the newest installed version.
Set `MINE` to the version in the `synergy-version` marker just above, then run:

```bash
MINE="0.15.0"  # ← the synergy-version marker above
CACHE="${CLAUDE_PLUGINS_DIR:-$HOME/.claude/plugins}/cache/synergy/synergy"
NEWEST="$(ls "$CACHE" 2>/dev/null | sort -V | tail -1)"
if [ -n "$NEWEST" ] && [ "$NEWEST" != "$MINE" ] && \
   [ "$(printf '%s\n%s\n' "$MINE" "$NEWEST" | sort -V | tail -1)" = "$NEWEST" ]; then
  printf '⚠ synergy: this session loaded v%s, but v%s is installed. Restart Claude Code to load the latest skills/templates.\n' "$MINE" "$NEWEST"
fi
```

If it prints a warning, **surface that line to the user verbatim** before continuing.
Then proceed — staleness is a warning, not a block.

# execute

Drives implementation of a Synergy session with a hard state-write gate. State is written ONLY through the `synergy` CLI (never by hand-editing `.state/`).

CLI base: `node "$CLAUDE_PLUGIN_ROOT/packages/cli/dist/cli.js"`.

## Steps

**1. Resolve the session + directives**
- The user's request is `$ARGUMENTS`. The first token (if it looks like a session slug) is the session; the rest are run-time directives (e.g. "only Phase 1", "use sonnet").
- If no session is given, read `.synergy/active-session` (JSON `{ session, lastSeen }`); use it if `lastSeen` is within 10 minutes, else ask which session.

**2. Read state first, then strategy, then detail**
- **Read `.synergy/sessions/<session>/.state/handoff.md` first** if it exists. It is the
  latest KT baton (overwrite/latest-wins — a single current snapshot, not a log) and your
  router. If it names an in-progress phase in "Current phase state", **resume that phase
  from its "Next concrete step" — do not restart it from scratch.** This closes the
  mid-phase gap where a phase is `in-progress` with no boundary note.
- **Pull history conditionally.** When the handoff routes you into a phase, read that
  phase's log `.state/phases/<slug>.md` and — only if you need cross-cutting context —
  `.state/journal.md`. These are the append-only backstory behind the handoff snapshot.
  Handoff = "you are here"; journals = the backstory; KT is the two together. Do not read
  the journals unconditionally at orientation.
- Run `synergy status <session>` — note the rollup and the resume pointer.
- Read `.synergy/sessions/<session>/orchestrator.md` (strategy, dependency graph, agent allocation).
- Read the relevant phase `spec.mdx` (folder phases under `phases/<NN>-<slug>/`, or the `<Phase id>` blocks in the implementation spec).
- The handoff routes; the phase `spec.mdx` is pulled **lazily** — only the phase you are
  about to implement, at implement-time. Never front-load all phase specs.

**3. Pick the next phase and mark it in-progress**
- Choose the lowest-ordered phase whose status is not `done`/`shipped` (respect any scope directive).
- `synergy phase set <session> <phaseId> in-progress`

**4. Implement the phase**
- Fan out per the phase's agent references: each `<Phase>` names its agents; look those
  names up in the session's `<AgentTree>` to get each agent's **model** and **effort**
  (effort inherits from the nearest ancestor; model is per-node). Spawn the specified
  `type` and `count` (count, if any, stays on the tree node) at that model/effort.
  **Run-time directives override these for THIS run only — never rewrite the `<AgentTree>`.**
- As you discover anything surprising or reusable, record it (prefer the daemon; fall back to the CLI):
  ```bash
  # Fast path:
  # Assign PREVIEW_ORIGIN from `preview status --json`; do not assume a port.
  curl -sS -X POST "${PREVIEW_ORIGIN}/api/log" \
    -H 'content-type: application/json' \
    -d '{"session":"<session>","text":"<finding>","phase":"<phaseId>"}'
  # For cross-cutting findings use "global":true instead of "phase":"..."

  # Fallback:
  node "$CLAUDE_PLUGIN_ROOT/packages/cli/dist/cli.js" log <session> "<finding>" --phase <phaseId>
  ```
- Run the phase's verification gate (from orchestrator.md).

**5. [MANDATORY GATE] Close out the phase before moving on**
You may NOT start the next phase until all three are done:

- Write the phase status (prefer the daemon; fall back to the CLI on `ECONNREFUSED`):
  ```bash
  # Fast path (daemon running):
  curl -sS -X POST "${PREVIEW_ORIGIN}/api/phase" \
    -H 'content-type: application/json' \
    -d '{"session":"<session>","phaseId":"<phaseId>","status":"done","note":"<terse boundary note: what changed, deviations>"}'

  # Fallback (preview not running):
  node "$CLAUDE_PLUGIN_ROOT/packages/cli/dist/cli.js" phase set <session> <phaseId> done --note "<boundary note>"
  ```
  The gate is **not satisfied** until the phase status is confirmed written.

- Write the resume pointer:
  ```bash
  # Fast path:
  curl -sS -X POST "${PREVIEW_ORIGIN}/api/resume" \
    -H 'content-type: application/json' \
    -d '{"session":"<session>","next":"<nextPhaseId>","note":"<where the next agent should start>"}'

  # Fallback:
  node "$CLAUDE_PLUGIN_ROOT/packages/cli/dist/cli.js" continue <session> --next <nextPhaseId> --note "<note>"
  ```

- Stop for the human checkpoint defined at this phase boundary.

**6. Repeat** from step 3 until all phases are done (or the scope directive's stopping point is reached). Then print the final `synergy status <session>`.

## Don'ts
- Don't hand-edit `.state/` JSON or journals — always go through the CLI.
- Don't skip the boundary note or resume pointer — that's the hand-off a fresh agent depends on.
- Don't let a run directive ("use sonnet") mutate the stored `<AgentTree>` plan.
- Don't mark a phase `done` if its verification gate failed — use `blocked` and log why.
