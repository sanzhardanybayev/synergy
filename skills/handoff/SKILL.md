---
name: handoff
description: Use when the user runs /synergy-handoff or asks Claude to capture a knowledge-transfer handoff for the active Synergy session before quitting. Snapshots the live agent's working context into .state/handoff.md so a future agent can resume exactly where it left off, even mid-phase.
---

<!-- synergy-version: 0.12.0 -->

## Step 0 — Freshness check (run before anything else)

This skill loads at session start, so it can be **stale** if the plugin was updated
mid-session. Before doing any work, confirm you are the newest installed version.
Set `MINE` to the version in the `synergy-version` marker just above, then run:

```bash
MINE="0.12.0"  # ← the synergy-version marker above
CACHE="${CLAUDE_PLUGINS_DIR:-$HOME/.claude/plugins}/cache/synergy/synergy"
NEWEST="$(ls "$CACHE" 2>/dev/null | sort -V | tail -1)"
if [ -n "$NEWEST" ] && [ "$NEWEST" != "$MINE" ] && \
   [ "$(printf '%s\n%s\n' "$MINE" "$NEWEST" | sort -V | tail -1)" = "$NEWEST" ]; then
  printf '⚠ synergy: this session loaded v%s, but v%s is installed. Restart Claude Code to load the latest skills/templates.\n' "$MINE" "$NEWEST"
fi
```

If it prints a warning, **surface that line to the user verbatim** before continuing.
Then proceed — staleness is a warning, not a block.

# handoff

Capture the current session's knowledge into `.state/handoff.md` so a future agent
resumes exactly where you stopped — even mid-phase. You (the live agent) author the
snapshot from your own context.

CLI base: `node "$CLAUDE_PLUGIN_ROOT/packages/cli/dist/cli.js"`.

## Steps

**1. Resolve the session** — same as `synergy:execute` step 1 (`$ARGUMENTS` first token, else
`.synergy/active-session` within the 10-minute window, else ask).

**2. Author the handoff snapshot** from your own working context. Fill every section;
"none" is a valid value:

```markdown
## What I did this session
## In-flight / half-done   (files touched but not complete; what's missing)
## Next concrete step       (the single first action the next agent should take)
## Gotchas / dead-ends      (what NOT to retry, surprising constraints)
## Open questions           (decisions deferred to a human)
## Current phase state      (phaseId + rough %; e.g. "storage ~60%")
```

Reference the phase by its **slug** (e.g. `storage`), never a file path like
`phases/01-storage/spec.mdx` — numeric prefixes are sort-order, not identity, and rot
under renumbering. Carry knowledge + slug only; the resuming agent resolves the spec path
from the slug via the fixed layout convention. Do not embed `spec:`/`orchestrator:` links.

**3. Write it.** Prefer the daemon; fall back to the CLI. Write the body to a temp file to
avoid shell-escaping a large multi-line dump:

```bash
BODY_FILE="$(mktemp)"
cat > "$BODY_FILE" <<'EOF'
## What I did this session
…
## Current phase state
storage ~60%
EOF

# Fast path (daemon running):
# Assign PREVIEW_ORIGIN from `preview status --json`; do not assume a port.
curl -sS -X POST "${PREVIEW_ORIGIN}/api/handoff" \
  -H 'content-type: application/json' \
  -d "$(python3 -c 'import json,sys;print(json.dumps({"session":sys.argv[1],"next":sys.argv[2],"body":open(sys.argv[3]).read()}))' "<session>" "<nextPhaseId>" "$BODY_FILE")"

# Fallback (preview not running):
node "$CLAUDE_PLUGIN_ROOT/packages/cli/dist/cli.js" handoff <session> --next <nextPhaseId> --body-file "$BODY_FILE"
```

**4. Confirm** the path (`.state/handoff.md`) and resume pointer back to the user. It is now
safe to quit — a future `/synergy-continue` or `/synergy-execute` will read this first.

## Don'ts
- Don't hand-edit `.state/handoff.md` — always go through the CLI/daemon.
- Don't omit "Next concrete step" or "Current phase state" — those are what let a fresh
  agent resume mid-phase instead of restarting it.
- Don't delete the prior handoff — `writeHandoff` overwrites it (latest-wins).
