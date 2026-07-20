---
name: preview-control
description: Use when the user wants to start, stop, or check the Synergy preview server. Triggers on "start preview", "stop the preview", "is the preview running", "/synergy-preview-start", "/synergy-preview-stop", "/synergy-preview-status".
---

# preview-control

Manage the Synergy preview server lifecycle. The server prefers port `4321`, can select another loopback port, and serves the MDX session previews with hot reload.

## Lifecycle

- **Runtime authority:** `.synergy/preview.runtime.json` is published only after project-identity health verification. Use the CLI instead of reading it directly.
- **Port:** `4321` is the preferred port. Default startup selects another available loopback port when necessary; an explicit `--port` is strict.
- **Log file:** `.synergy/preview.log` (gitignored). Tail it when diagnosing failures.

## CLI invocation

The plugin's CLI lives at `$CLAUDE_PLUGIN_ROOT/packages/cli/dist/cli.js`. Always invoke it via:

```
node "$CLAUDE_PLUGIN_ROOT/packages/cli/dist/cli.js" preview <action>
```

If the file doesn't exist, the plugin archive is incomplete. `/synergy-setup` installs dependencies but does not build or repair runtime artifacts.

## Commands

| User intent | Run |
|---|---|
| Start the preview | `node "$CLAUDE_PLUGIN_ROOT/packages/cli/dist/cli.js" preview start` |
| Stop the preview | `node "$CLAUDE_PLUGIN_ROOT/packages/cli/dist/cli.js" preview stop` |
| Check status | `node "$CLAUDE_PLUGIN_ROOT/packages/cli/dist/cli.js" preview status --json` |

`start` is idempotent — if a server is already running, it tells you and exits without spawning a second one.

`stop` uses the authenticated runtime shutdown endpoint and removes only matching runtime metadata. It never kills an unverified process.

`status --json` returns `running` plus the verified `origin`; treat that origin as the only URL authority.

## When to invoke

- After creating a spec with `create-spec`, the preview is auto-started. You usually don't need to start it again.
- Stop the preview when the user is done iterating, or if it's misbehaving.
- Check status before assuming the URL is reachable.

## Failure modes

- Missing dependency errors → run `/synergy-setup` to perform the frozen dependency install.
- Default preferred-port conflict → the CLI selects another port and reports its verified origin.
- Explicit `--port` conflict → choose another explicit port or omit `--port`; never kill the occupying process automatically.
- Stale or unhealthy runtime metadata → the CLI leaves unrelated processes untouched; retry `start` and use `preview status --json` to discover the new origin.
