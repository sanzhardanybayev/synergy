---
name: preview-control
description: Use when the user wants to start, stop, or check the Synergy preview server. Triggers on "start preview", "stop the preview", "is the preview running", "/synergy-preview-start", "/synergy-preview-stop", "/synergy-preview-status".
---

# preview-control

Manage the Synergy preview server lifecycle. The server runs on port `4321` and serves the MDX session previews with hot reload.

## Lifecycle

- **PID file:** `.synergy/preview.pid` in the project root. Presence + alive check = "running."
- **Port:** fixed at `4321`. If another process is on that port, `synergy preview start` will fail loudly — don't try to free it; ask the user.
- **Log file:** `.synergy/preview.log` (gitignored). Tail it when diagnosing failures.

## Commands

| User intent | Run |
|---|---|
| Start the preview | `synergy preview start` |
| Stop the preview | `synergy preview stop` |
| Check status | `synergy preview status` |

`start` is idempotent — if a server is already running, it tells you and exits without spawning a second one.

`stop` sends SIGTERM, waits briefly, then SIGKILL if necessary, and removes the PID file.

`status` prints `running` / `stopped` plus pid and url.

## When to invoke

- After creating a spec with `create-spec`, the preview is auto-started by `synergy spec`. You usually don't need to start it again.
- Stop the preview when the user is done iterating, or if it's misbehaving.
- Check status before assuming the URL is reachable.

## Failure modes

- "vite binary not found" → the workspace's `node_modules` isn't installed. Have the user run `pnpm install` in the synergy repo.
- "port 4321 in use" → another process owns the port. Have the user identify it (`lsof -i :4321`) rather than auto-killing.
- "stale pid in preview.pid" → the CLI handles this automatically; just retry `start`.
