---
name: execute
description: Use when the user runs /synergy-execute or asks Claude to implement a Synergy spec session phase by phase. Owns the disciplined execution loop — reads orchestrator + live .state, works one phase at a time, and writes a boundary note + flips phase status via the synergy CLI before moving on. Honors run-time directives (scope, model/effort overrides) layered above the plan.
---

# execute

Drives implementation of a Synergy session with a hard state-write gate. State is written ONLY through the `synergy` CLI (never by hand-editing `.state/`).

CLI base: `node "$CLAUDE_PLUGIN_ROOT/packages/cli/dist/cli.js"`.

## Steps

**1. Resolve the session + directives**
- The user's request is `$ARGUMENTS`. The first token (if it looks like a session slug) is the session; the rest are run-time directives (e.g. "only Phase 1", "use sonnet").
- If no session is given, read `.synergy/active-session` (JSON `{ session, lastSeen }`); use it if `lastSeen` is within 10 minutes, else ask which session.

**2. Read state first, then strategy, then detail**
- Run `synergy status <session>` — note the rollup and the resume pointer.
- Read `.synergy/sessions/<session>/orchestrator.md` (strategy, dependency graph, agent allocation).
- Read the relevant phase `spec.mdx` (folder phases under `phases/<NN>-<slug>/`, or the `<Phase id>` blocks in the implementation spec).

**3. Pick the next phase and mark it in-progress**
- Choose the lowest-ordered phase whose status is not `done`/`shipped` (respect any scope directive).
- `synergy phase set <session> <phaseId> in-progress`

**4. Implement the phase**
- Fan out per the `<AgentAllocation>` entries for this phase: spawn the specified agent `type`, `count`, `model`, and `effort`. Run-time directives override these for THIS run only — never rewrite `<AgentAllocation>`.
- As you discover anything surprising or reusable, record it (prefer the daemon; fall back to the CLI):
  ```bash
  # Fast path:
  curl -sS -X POST http://localhost:4321/api/log \
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
  curl -sS -X POST http://localhost:4321/api/phase \
    -H 'content-type: application/json' \
    -d '{"session":"<session>","phaseId":"<phaseId>","status":"done","note":"<terse boundary note: what changed, deviations>"}'

  # Fallback (preview not running):
  node "$CLAUDE_PLUGIN_ROOT/packages/cli/dist/cli.js" phase set <session> <phaseId> done --note "<boundary note>"
  ```
  The gate is **not satisfied** until the phase status is confirmed written.

- Write the resume pointer:
  ```bash
  # Fast path:
  curl -sS -X POST http://localhost:4321/api/resume \
    -H 'content-type: application/json' \
    -d '{"session":"<session>","next":"<nextPhaseId>","note":"<where the next agent should start>"}'

  # Fallback:
  node "$CLAUDE_PLUGIN_ROOT/packages/cli/dist/cli.js" resume <session> --next <nextPhaseId> --note "<note>"
  ```

- Stop for the human checkpoint defined at this phase boundary.

**6. Repeat** from step 3 until all phases are done (or the scope directive's stopping point is reached). Then print the final `synergy status <session>`.

## Don'ts
- Don't hand-edit `.state/` JSON or journals — always go through the CLI.
- Don't skip the boundary note or resume pointer — that's the hand-off a fresh agent depends on.
- Don't let a run directive ("use sonnet") mutate the stored `<AgentAllocation>` plan.
- Don't mark a phase `done` if its verification gate failed — use `blocked` and log why.
