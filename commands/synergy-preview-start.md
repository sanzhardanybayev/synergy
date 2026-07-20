---
description: Start the Synergy preview server and report its verified runtime URL
---

Run `node "$CLAUDE_PLUGIN_ROOT/packages/cli/dist/cli.js" preview start` in the current project root.

If a healthy server for this project is already running, the CLI will say so and exit cleanly — that's expected. Otherwise it starts the runtime, preferring port `4321` and selecting another loopback port when needed, then reports success only after health verification.

After starting, run `node "$CLAUDE_PLUGIN_ROOT/packages/cli/dist/cli.js" preview status --json`, read the non-null `origin`, and point the user to that runtime URL. The most recently modified session is shown by default. Never construct a fixed host or port.
