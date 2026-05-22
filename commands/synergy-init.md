---
description: Initialize Synergy in the current project (creates .synergy/ scaffold)
---

Run `node "$CLAUDE_PLUGIN_ROOT/packages/cli/dist/cli.js" init` in the current project root.

Creates `.synergy/sessions/` and a local `.gitignore` that excludes preview lifecycle files. Run this once per project before `/synergy-spec`.

If the CLI doesn't exist at that path yet, run `/synergy-setup` first to build the plugin.
