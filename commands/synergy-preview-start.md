---
description: Start the Synergy preview server on http://localhost:4321
---

Run `node "$CLAUDE_PLUGIN_ROOT/packages/cli/dist/cli.js" preview start` in the current project root.

If a server is already running, the CLI will say so and exit cleanly — that's expected. Otherwise it spawns vite, writes the PID to `.synergy/preview.pid`, and reports the URL.

After starting, point the user to `http://localhost:4321/`. The most recently modified session is shown by default.
