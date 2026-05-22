# Synergy

MDX spec authoring with a live web preview, packaged as a Claude Code plugin. Generate cross-referenced specification sessions from your editor and iterate on them in the browser.

## Why

Markdown plans get unreadable fast — terminal/IDE rendering is flat, charts are missing, and structure (status, risks, phases, allocations) is hard to scan. Synergy gives agents a small MDX component vocabulary, a validator that enforces it, and a Vite preview that hot-reloads as you author.

## Install

```bash
git clone <repo> synergy && cd synergy
pnpm install
pnpm build
```

To use as a Claude Code plugin, point your plugin marketplace at `plugins/claude-code/` (it exposes the `synergy` plugin with skills + slash commands).

## Quick start

```bash
cd your-project
# One-time scaffold:
synergy init

# Create a session:
synergy spec "Add rate limiting" --type feature
# → creates .synergy/sessions/2026-05-22-add-rate-limiting/
# → starts preview at http://localhost:4321
# → opens your browser to the new session

# Iterate:
#   Edit any MDX in the session — the browser hot-reloads on save.

# Validate before committing:
synergy validate

# Manage the preview:
synergy preview status   # is it running?
synergy preview stop     # shut it down
```

In Claude Code, the slash commands are equivalent: `/synergy-spec`, `/synergy-validate`, `/synergy-preview-start|stop|status`, `/synergy-init`.

## Session layout

```
.synergy/sessions/<YYYY-MM-DD-slug>/
├── 00-overview.mdx          status, goals, sub-spec map, open questions, risks
├── 01-architecture.mdx      system shape, diagrams
├── 02-implementation.mdx    phased build, agent allocation, timeline
├── NN-<your-slug>.mdx       optional additional sub-specs
├── orchestrator.md          plain-markdown playbook for implementing the work
├── _components/             session-local React/MDX components
└── assets/                  images and mockups
```

## Spec-kit components

Imported from `@synergy/spec-kit`. The validator enforces props against generated JSON schemas.

| Component | Purpose |
|---|---|
| `<Status>` | Lifecycle badge (`draft`, `proposed`, `in-progress`, `blocked`, `done`, `shipped`) |
| `<Phase>` | Implementation phase with optional `status`, `estimate`, `summary` |
| `<Timeline>` | Ordered milestones with dates and statuses |
| `<SubSpec>` | Sibling-spec link card |
| `<CrossRef>` | Inline cross-document reference (validator-enforced) |
| `<AgentAllocation>` | Table of agents (sub-agent / agent-team / human) and ownership |
| `<Team>` | Group of contributors with roles |
| `<Reviewer>` | Single reviewer and sign-off scope |
| `<OpenQuestion>` | Unresolved decision blocking progress |
| `<Risk>` | Known hazard with severity and mitigation |
| `<Mockup>` | Image with caption |
| `<Chart>` | Mermaid diagram (flow / sequence / state / gantt / ER / mindmap / architecture) |

For visuals beyond Mermaid, drop a session-local component in `_components/` and import any chart library you need.

## Cross-reference syntax

```mdx
<CrossRef to="01-architecture" />                       <!-- whole file -->
<CrossRef to="01-architecture#token-flow" />            <!-- specific heading -->
<CrossRef to="01-architecture">the architecture</CrossRef> <!-- custom label -->
```

Heading anchors are GitHub-style (lowercase, spaces → `-`, special chars stripped). The validator resolves every target — dangling refs are errors.

## Orchestrator file

Every session has an `orchestrator.md` (plain markdown — readable in any tool, including a terminal). It tells the implementing agent how to execute the work: dependency graph, parallelizable chunks, sub-agent vs agent-team strategy, verification gates.

When you want to implement the spec, reference the session in Claude Code:

```
Implement the plan in @.synergy/sessions/<name>/ — start with orchestrator.md.
```

## Architecture

```
synergy/
├── packages/
│   ├── spec-kit/        MDX component library + JSON schemas
│   ├── validator/       MDX parser + schema check + cross-ref resolver
│   ├── preview/         Vite + React app, watches .synergy/sessions/
│   └── cli/             synergy CLI (init / spec / preview / validate)
├── plugins/claude-code/ plugin manifest + skills + slash commands
└── examples/refactor-auth/  canonical example session
```

- **Preview port:** fixed at `4321`.
- **Session naming:** `YYYY-MM-DD-<slug>` from the title; collision → 6-char hash suffix.
- **Codex / other hosts:** not in v1.

See `AGENTS.md` for the spec-authoring rules and `CLAUDE.md` for project conventions.

## Development

```bash
pnpm install
pnpm build            # builds all packages
pnpm typecheck        # tsc across the workspace
pnpm validate         # runs the validator against examples/
pnpm preview:start    # boots preview against examples/
pnpm preview:stop
```

## License

MIT.
