---
name: resume
description: Use when the user runs /synergy-resume or asks a fresh-context agent to continue an in-progress Synergy session. Reconstructs context from the execution-state hand-off (resume pointer + journals) before reading the plan, then continues the execute loop from where the previous agent stopped.
---

# resume

The fresh-context entry point. Reads state FIRST so you start exactly where the last agent left off.

CLI base: `node "$CLAUDE_PLUGIN_ROOT/packages/cli/dist/cli.js"`.

## Steps

**1. Resolve the session + directives** — same as `synergy:execute` step 1 (`$ARGUMENTS`; fall back to `.synergy/active-session`).

**2. Load the hand-off (state first)**
- `synergy status <session>` — read the rollup and the **resume pointer** (`next` + note). This is your starting instruction.
- Read `.synergy/sessions/<session>/.state/phases/<nextPhase>.md` and any prior phases' boundary notes.
- Read `.synergy/sessions/<session>/.state/journal.md` (cross-cutting findings).

**3. Load strategy + detail**
- Read `orchestrator.md`, then the `spec.mdx` for the phase named by the resume pointer.

**4. Continue**
- Hand off to the `synergy:execute` loop starting at its step 3, beginning with the resume pointer's `nextPhase`. Apply any run-time directives the user passed.

## Don'ts
- Don't start by reading the plan — read the resume pointer + journals first; they encode what actually happened.
- Don't re-do completed phases (status `done`/`shipped`) unless a directive says to re-verify.
