---
description: Bootstrap the Synergy plugin dependencies. Run once after install.
---

The Synergy plugin ships its runtime artifacts. Run this once after installing the plugin (or after a `git pull`) to install their locked dependencies.

Execute, in order:

1. `cd "$CLAUDE_PLUGIN_ROOT" && pnpm install --frozen-lockfile`
2. `node "$CLAUDE_PLUGIN_ROOT/packages/cli/dist/cli.js" --help`

Do not run a build command. The Git-backed plugin archive already contains the runtime output, and setup must not rewrite it.

If pnpm isn't installed, instruct the user to install it (`npm i -g pnpm` or `corepack enable`). Do not silently fall back to npm — the workspace uses pnpm-specific protocols (`workspace:*`).

After setup completes, all other `/synergy-*` commands work.
