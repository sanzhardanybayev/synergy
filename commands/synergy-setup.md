---
description: Bootstrap the Synergy plugin (install + build). Run once after install.
---

The Synergy plugin ships source for its CLI and preview server. Run this once after installing the plugin (or after a `git pull`) to install dependencies and build the workspace.

Execute, in order:

1. `cd "$CLAUDE_PLUGIN_ROOT" && pnpm install`
2. `cd "$CLAUDE_PLUGIN_ROOT" && pnpm build`

Verify the CLI is ready:

```
node "$CLAUDE_PLUGIN_ROOT/packages/cli/dist/cli.js" --help
```

If pnpm isn't installed, instruct the user to install it (`npm i -g pnpm` or `corepack enable`). Do not silently fall back to npm — the workspace uses pnpm-specific protocols (`workspace:*`).

After setup completes, all other `/synergy-*` commands work.
