---
name: continue
description: Use when the user runs /synergy-continue or asks a fresh-context agent to continue an in-progress Synergy session. Reconstructs context from the execution-state hand-off (resume pointer + journals) before reading the plan, then continues the execute loop from where the previous agent stopped.
---

<!-- synergy-version: 0.12.1 -->

## Step 0 — Freshness check (run before anything else)

This skill loads at session start, so it can be **stale** if the plugin was updated
mid-session. Before doing any work, confirm you are the newest installed version.
Set `MINE` to the version in the `synergy-version` marker just above, then run:

```bash
MINE="0.12.1"  # ← the synergy-version marker above
CACHE="${CLAUDE_PLUGINS_DIR:-$HOME/.claude/plugins}/cache/synergy/synergy"
NEWEST="$(ls "$CACHE" 2>/dev/null | sort -V | tail -1)"
if [ -n "$NEWEST" ] && [ "$NEWEST" != "$MINE" ] && \
   [ "$(printf '%s\n%s\n' "$MINE" "$NEWEST" | sort -V | tail -1)" = "$NEWEST" ]; then
  printf '⚠ synergy: this session loaded v%s, but v%s is installed. Restart Claude Code to load the latest skills/templates.\n' "$MINE" "$NEWEST"
fi
```

If it prints a warning, **surface that line to the user verbatim** before continuing.
Then proceed — staleness is a warning, not a block.

# continue

The fresh-context entry point. Reads state FIRST so you start exactly where the last agent left off.

CLI base: `node "$CLAUDE_PLUGIN_ROOT/packages/cli/dist/cli.js"`.

## Steps

**1. Resolve the session + directives** — same as `synergy:execute` step 1 (`$ARGUMENTS`; fall back to `.synergy/active-session`).

**2. Load the hand-off (state first)**
- **Read `.synergy/sessions/<session>/.state/handoff.md` first** if it exists — the latest
  brain-dump from the agent that just stopped (what's half-done, the next concrete step,
  gotchas, current phase slug). This is your primary starting instruction and router; pull
  the resume pointer + journals below only for the phase it points you into.
- Read the rollup and the **resume pointer** (`next` + note) — this is your starting instruction.
  Prefer the daemon endpoint; fall back when the preview is not running:
  ```bash
  # Fast path (daemon running):
  # Assign PREVIEW_ORIGIN from `preview status --json`; do not assume a port.
  curl -sS "${PREVIEW_ORIGIN}/api/progress?session=<session>"
  # The response contains progress.resume.nextPhase and progress.resume.note.

  # Fallback (preview not running):
  # Read .synergy/sessions/<session>/.state/progress.json directly, or run:
  node "$CLAUDE_PLUGIN_ROOT/packages/cli/dist/cli.js" status <session>
  ```
- Read `.synergy/sessions/<session>/.state/phases/<nextPhase>.md` and any prior phases' boundary notes.
- Read `.synergy/sessions/<session>/.state/journal.md` (cross-cutting findings).

**3. Load strategy + detail**
- Read `orchestrator.md`, then the `spec.mdx` for the phase named by the resume pointer.

**4. Continue**
- Hand off to the `synergy:execute` loop starting at its step 3, beginning with the resume pointer's `nextPhase`. Apply any run-time directives the user passed.

## Don'ts
- Don't start by reading the plan — read the resume pointer + journals first; they encode what actually happened.
- Don't re-do completed phases (status `done`/`shipped`) unless a directive says to re-verify.
