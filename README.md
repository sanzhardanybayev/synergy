# Synergy

**Spec-driven planning for Claude Code.** Turn vague requests into MDX specifications with status badges, phase plans, agent allocations, charts, and cross-references — rendered live in your browser as you author them.

Markdown specs go stale in a terminal. Synergy gives agents a tight component vocabulary, a validator that enforces it, and a Vite preview that hot-reloads on every save.

## Demo

![Synergy preview rendering a refactor session](docs/screenshot.png)

The preview at `http://localhost:4321` renders MDX with reusable spec components (`<Status>`, `<Phase>`, `<Chart>`, `<CrossRef>`, …), a session switcher, and an orchestrator panel. Hot-reloads as Claude Code edits the files.

## Install

Prerequisites: **Node ≥ 20**, **pnpm** (`corepack enable` if missing).

```
/plugin marketplace add sanzhardanybayev/synergy
/plugin install synergy@synergy
/synergy-setup
```

`/synergy-setup` runs `pnpm install && pnpm build` inside the plugin once. After that, the slash commands and skills are ready.

<details>
<summary>Install from a local clone</summary>

```bash
git clone https://github.com/sanzhardanybayev/synergy
# In Claude Code:
/plugin marketplace add /absolute/path/to/synergy
/plugin install synergy@synergy
/synergy-setup
```
</details>

## Quick start

```
/synergy-init                              # once per project
/synergy-spec "Add rate limiting"          # creates a session + opens browser
# ...edit MDX with Claude Code, preview hot-reloads...
/synergy-validate                          # before commit
```

That's the loop. The first command scaffolds `.synergy/sessions/` in your project. The second creates `.synergy/sessions/YYYY-MM-DD-add-rate-limiting/` with `00-overview.mdx`, `01-architecture.mdx`, `02-implementation.mdx`, and an `orchestrator.md` playbook — then opens your browser. The third checks schemas and cross-references before you ship.

## Reference

### Slash commands

| Command | Purpose |
|---|---|
| `/synergy-init` | Scaffold `.synergy/` in the current project. Once per project. |
| `/synergy-spec "<title>"` | Create a new spec session (also auto-starts preview, opens browser). |
| `/synergy-validate [session]` | Validate schemas + cross-refs. Zero errors before commit. |
| `/synergy-preview-start` | Boot the preview server on port 4321. Idempotent. |
| `/synergy-preview-stop` | Kill the preview server, remove PID file. |
| `/synergy-preview-status` | Report running / stopped, pid, URL. |
| `/synergy-setup` | One-time bootstrap (install + build). |

### CLI subcommands

For terminal users — same surface, available at `node "$CLAUDE_PLUGIN_ROOT/packages/cli/dist/cli.js" ...` after `/synergy-setup`.

| Command | Flags | Purpose |
|---|---|---|
| `synergy init` | `--root <dir>` | Scaffold `.synergy/` |
| `synergy spec <title>` | `--type feature\|refactor\|project`, `--name`, `--no-preview`, `--no-open`, `--root` | Create a session |
| `synergy preview <action>` | `--root`, `--port` (default 4321) | `start \| stop \| status` |
| `synergy validate [session]` | `--root` | Validate sessions in `.synergy/sessions/` |

### Spec-kit components

Imported from `@synergy/spec-kit`. Props are schema-validated; cross-references are link-checked.

| Component | Required props | One-line purpose |
|---|---|---|
| `<Status>` | `value` | Lifecycle badge: `draft`, `proposed`, `in-progress`, `blocked`, `done`, `shipped` |
| `<Phase>` | `number`, `title` | Implementation phase block (optional `status`, `estimate`, `summary`) |
| `<Timeline>` | `milestones` | Ordered visual milestones with optional dates and statuses |
| `<SubSpec>` | `slug`, `title` | Link card to a sibling spec file |
| `<CrossRef>` | `to` | Inline reference; `to="<spec-slug>"` or `"<spec-slug>#<heading-slug>"` |
| `<AgentAllocation>` | `entries` | Table of agents (`sub-agent`, `agent-team`, `human`) and ownership |
| `<Team>` | `name`, `members` | Group of contributors with roles |
| `<Reviewer>` | `name`, `role`, `scope` | Reviewer and their sign-off scope |
| `<OpenQuestion>` | `question` | Unresolved decision blocking progress |
| `<Risk>` | `title`, `severity` | Known hazard with optional mitigation |
| `<Mockup>` | `src`, `alt` | Image with caption (relative to session `assets/`) |
| `<Chart>` | source as children | Mermaid diagram (`flow`, `sequence`, `state`, `gantt`, `er`, `mindmap`, `architecture`) |

For visuals beyond Mermaid, drop a custom component in `.synergy/sessions/<name>/_components/` and import it locally.

## Authoring rules

Four rules. Full text in [AGENTS.md](AGENTS.md).

1. **Components over markdown.** Use spec-kit components for structured content. If the shape doesn't exist, build a session-local component — don't fall back to raw markdown.
2. **CrossRefs, not links.** Spec-to-spec navigation uses `<CrossRef to="...">`. The validator catches dangling refs; raw markdown links it can't.
3. **Every session ships an `orchestrator.md`.** Plain markdown, not MDX, so it's readable in any tool. Describes dependency graph, parallel chunks, sub-agent vs agent-team strategy, verification gates.
4. **Validator is the gate.** `synergy validate` returns zero errors before a session is considered ready.

## Troubleshooting

**"vite binary not found" or "command not found"** — the plugin's workspace isn't built. Run `/synergy-setup`. If pnpm itself is missing, `corepack enable` or `npm i -g pnpm`.

**"port 4321 in use"** — another process owns the port. Run `/synergy-preview-stop` first; if a different program holds it, identify with `lsof -i :4321` and quit it before retrying.

**Validation fails on `<CrossRef>`** — the target slug or heading anchor doesn't exist in the session. Either fix the `to=` value or add the heading. Anchors are GitHub-style: lowercase, spaces → `-`, special chars stripped.

## License & links

MIT. See [AGENTS.md](AGENTS.md) for spec-authoring rules, [CLAUDE.md](CLAUDE.md) for project conventions, [SYNERGY_PLAN.md](SYNERGY_PLAN.md) for the original design.
