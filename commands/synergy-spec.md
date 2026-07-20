---
description: Create a new Synergy MDX spec session and auto-open the preview
argument-hint: <title> [feature|refactor|project]
---

Invoke the `synergy:create-spec` skill to author a new spec session.

The user's request: `$ARGUMENTS`

There is **no `synergy spec` CLI command**. The `create-spec` skill owns
the authoring path: it reads templates from
`$CLAUDE_PLUGIN_ROOT/skills/create-spec/templates/`, substitutes
placeholders, writes them into `.synergy/sessions/<YYYY-MM-DD-slug>/`,
starts the preview server, and prints the URL.

Follow the skill's procedure:

1. Decide the spec shape from the request — tiny, single-phase, or multi-phase. The skill's "Scope reasoning" table is the rubric.
2. Pick a session slug (`YYYY-MM-DD-<kebab-slug>`, max 40 chars, `-<6-char-hash>` on collision) and any phase slugs you need.
3. Create the session directory and copy the appropriate templates. Substitute `{{TITLE}}`, `{{TYPE}}`, `{{TODAY}}`, `{{PHASE_NUMBER}}`, `{{PHASE_TITLE}}`. Replace `<…-slug>` hint placeholders with real slugs.
4. Run `node "$CLAUDE_PLUGIN_ROOT/packages/cli/dist/cli.js" preview start` (idempotent), then run `node "$CLAUDE_PLUGIN_ROOT/packages/cli/dist/cli.js" preview status --json`. Build `/s/<session-name>/overview` from the returned non-null `origin` and print that complete URL for the user. Browser auto-open is best-effort.
5. Fill in the placeholder content from the conversation.
6. Run `node "$CLAUDE_PLUGIN_ROOT/packages/cli/dist/cli.js" validate <session-name>` and resolve every error before declaring done.

If the CLI binary doesn't exist yet, run `/synergy-setup` first.
