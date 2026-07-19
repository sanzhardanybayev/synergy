---
description: Stop the Synergy preview server
---

Run `node "$CLAUDE_PLUGIN_ROOT/packages/cli/dist/cli.js" preview stop` in the current project root.

The CLI validates `.synergy/preview.runtime.json` against the live loopback health endpoint, then requests shutdown through the runtime's authenticated control endpoint. It never signals an unverified PID. If no verified preview is running, it reports that state and exits nonzero so automation does not treat shutdown as confirmed.
