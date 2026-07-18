# AGENTS.md — Synergy spec authoring

Rules and conventions for any agent (Claude Code, Codex, or otherwise) that authors or edits Synergy MDX spec sessions. Cross-host file — kept in sync with `CLAUDE.md`.

## What Synergy is

A spec-authoring system. Agents generate cross-referenced MDX documents in `.synergy/sessions/<session-name>/` and render them in a Vite + React preview at `http://localhost:4321`. A separate `orchestrator.md` per session tells the implementing agent how to execute the work (sequencing, parallelism, agent strategy).

## Hard rules

1. **Session location.** All spec content lives in `.synergy/sessions/<YYYY-MM-DD-<slug>>/`. Never write spec files anywhere else in the consumer project.
2. **Components over markdown.** Prefer spec-kit components (`<Status>`, `<Phase>`, `<Timeline>`, `<SubSpec>`, `<CrossRef>`, `<AgentAllocation>`, `<OpenQuestion>`, `<Risk>`, `<Mockup>`, `<Chart>`, `<Team>`, `<Reviewer>`) over ad-hoc markdown for structured content.
3. **Build, don't degrade.** When the structure you need doesn't exist in spec-kit, create a session-local component in `_components/` rather than falling back to raw markdown.
4. **CrossRefs are mandatory.** Every spec-to-spec link uses `<CrossRef to="<slug>" />` or `<CrossRef to="<slug>#<anchor>" />`. Phase refs use `<CrossRef to="phases/<slug>" />` — the slug, never the numeric prefix. Do not write `[link](other.mdx)` style markdown links — the validator can't enforce those.
5. **Phases are folders.** Every phase lives in `phases/<NN>-<slug>/` with a required `spec.mdx` and an optional `orchestrator.md`. Inline `<Phase>` blocks are summary cards in `02-implementation.mdx`, not the phase itself.
6. **Orchestrator file is required.** Every session has a root `orchestrator.md` (plain markdown, not MDX) describing dependency graph, parallel chunks, agent strategy, verification gates. Per-phase orchestrators are optional but recommended for multi-task phases.
7. **Validator is the gate.** A session is not "ready" until `synergy validate <session>` returns zero errors. Warnings are acceptable but must be reviewed.
8. **Charts.** Default to `<Chart>` (Mermaid). When Mermaid can't express what you need, write a session-local chart component in `_components/` using any library (recharts, visx, react-flow, …).
9. **Preview lifecycle.** The preview server runs on port `4321` only. PID at `.synergy/preview.pid`. Never bypass the CLI — always use `synergy preview start|stop|status`.
10. **Required overview headings.** `00-overview.mdx` must contain `## Summary` and `## Goals`. The validator errors out otherwise. Other sections are optional.

## Session structure

```
.synergy/sessions/<YYYY-MM-DD-slug>/
├── 00-overview.mdx          required: ## Summary + ## Goals at minimum
├── 01-architecture.mdx      optional: system shape, diagrams
├── 02-implementation.mdx    optional: timeline, agent allocation, phase index
├── NN-<custom>.mdx          optional: extra sub-specs, keep NN ordered
├── orchestrator.md          required: root-level implementation playbook
├── _components/             optional: session-local React/MDX components
├── assets/                  optional: images, mockups
└── phases/                  optional: omit for non-phased specs
    ├── 01-<slug>/
    │   ├── spec.mdx         required if folder exists
    │   └── orchestrator.md  optional; warned-on-miss for multi-task phases
    ├── 02-<slug>/
    └── ...
```

Minimal session: just `orchestrator.md` + `00-overview.mdx`. Everything else is optional.

## Generating a session

Spec authoring is a **skill**, not a CLI command. To create a new session, invoke the `synergy:create-spec` skill (or run `/synergy-spec "<title>"` in Claude Code, which dispatches to the skill).

The skill:
1. Reasons about scope (tiny note, single-phase, or multi-phase).
2. Picks a name (`YYYY-MM-DD-<slug>`) with a 6-char hash suffix on collision.
3. Scaffolds the session from templates that ship inside the skill (`skills/synergy/create-spec/templates/`).
4. Creates `phases/<NN>-<slug>/` folders for each phase it decided on.
5. Starts the preview server via `synergy preview start` (idempotent).
6. Prints the session URL: `http://localhost:4321/s/<session-name>/overview`.

Editing or extending an existing session uses the `synergy:spec-authoring` skill, which covers adding/inserting/renaming/removing phase folders without breaking cross-refs.

## Editing iterations

The preview hot-reloads on every save. Edit the MDX, watch the browser refresh, take user feedback, repeat. Add or remove `.mdx` files in the session and the virtual session index rebuilds — the page does a full reload automatically.

## Orchestrator template

Every `orchestrator.md` has these sections:

```markdown
# Orchestrator — <title>

> Session: <name>. Type: <feature|refactor|project>.

## Overview
One paragraph. What, why, success criteria.

## Dependency graph
ASCII or Mermaid representation of phase ordering. Same-line items can run in parallel.

## Parallel chunks
Explicit list of which phases can be sub-agent-parallel vs sequential.

## Agent strategy
- Sub-agents for: <bounded, well-specified tasks>
- Agent team for: <cross-cutting, exploratory work>
- Human in the loop at: <phase boundaries>

## Verification gates
- After Phase N: <command to run, criteria to meet>

## How to invoke
"Implement the plan in @.synergy/sessions/<name>/ — start with orchestrator.md."
```

## Cross-reference syntax

| Form | Meaning |
|---|---|
| `<CrossRef to="01-architecture" />` | Link to sibling spec file |
| `<CrossRef to="01-architecture#auth-flow" />` | Link to a heading inside a sibling |
| `<CrossRef to="01-architecture">the architecture spec</CrossRef>` | Custom link text |
| `<CrossRef to="phases/core" />` | Link to phase folder by slug (preferred phase form) |
| `<CrossRef to="phases/core#verification" />` | Link to a heading inside a phase `spec.mdx` |

Phase refs use the **slug** only — never the numeric prefix. `phases/01-core` is invalid. The numeric prefix orders folders on disk; the slug is the stable identifier. Renumbering phases (e.g. inserting `02-warmup` between `01-foundation` and what becomes `03-core`) does not break refs that use the slug form.

Legacy phase refs of the form `02-implementation#phase-2` still resolve but the validator warns and asks you to migrate to `phases/<slug>`.

Anchors are GitHub-style: lowercase, spaces → `-`, special chars stripped, deduped per file.

## Component cheat sheet

| Component | Required props | Notes |
|---|---|---|
| `<Status>` | `value` (StatusValue) | Lifecycle badge |
| `<Phase>` | `number`, `title` | Optional `status`, `estimate`, `summary` |
| `<Timeline>` | `milestones[]` | Ordered list with `label`, optional `when`, `status` |
| `<SubSpec>` | `slug`, `title` | Use in 00-overview to list session contents |
| `<CrossRef>` | `to` | Validator-enforced |
| `<AgentAllocation>` | `entries[]` | Each entry: `name`, `type` (sub-agent\|agent-team\|human), `responsibility` |
| `<Team>` | `name`, `members[]` | Each member: `name`, `role` |
| `<Reviewer>` | `name`, `role`, `scope` | Sign-off declarations |
| `<OpenQuestion>` | `question` | Optional `id`, `owner`, `resolveBy` |
| `<Risk>` | `title`, `severity` | Optional `id`, `category`, `mitigation` |
| `<Mockup>` | `src`, `alt` | `src` is relative to session dir (use `./assets/...`) |
| `<Chart>` | source (children or `source` prop) | Mermaid by default; `kind` informational |

## Inline editing and feedback (v2)

The preview at `http://localhost:4321` adds an edit and feedback layer on top of the
read-only v1 preview. Agents interact with it via the feedback skill; the browser UI is
for human reviewers.

- **Apply / Discard buffer.** Prose blocks are contentEditable in the browser. Every edit is
  held in memory until the human clicks **Apply** (flushes to the MDX file on disk) or
  **Discard** (reverts). No auto-save. Phase status dropdowns use the same buffer.
- **Selection comments.** A human selects text in the preview, clicks "+", leaves a note.
  Each comment is a markdown file at `.synergy/feedback/<session>/<id>.md` with YAML
  frontmatter carrying both line/col coordinates and a `before+selected+after` context
  string for drift-tolerant re-anchoring.
- **Diff view.** Top-toolbar toggle. Highlights committed and uncommitted changes since the
  human's last "Mark as reviewed". Review state persists to `.synergy/review-state.json`.
- **Pull-based handoff.** When the human runs `/synergy-feedback`, the
  `synergy:address-feedback` skill reads `.synergy/active-session`, loads all
  `status: open` comment files, edits the spec at each anchor, and PATCHes each comment
  to `resolved` or `rejected`. Run `synergy validate <session>` before declaring done.
  With `--wait`, the skill's Live wait mode blocks on `synergy feedback wait <session>`
  and loops until the human clicks **Done reviewing** (see CLAUDE.md "Live feedback loop").
- **Gitignored files.** `active-session` and `review-state.json` are per-machine state —
  do not commit them. `sessions/` and `feedback/` remain tracked (they are spec content).

## CLI surface

The CLI handles process and execution-state operations only — see CLAUDE.md "Commands" for the authoritative list of `synergy` subcommands and Claude Code slash commands. Spec creation and editing live in skills — there is no `synergy spec` command.

## Preview design system

The preview app's visual language ("Ember & Graphite" - warm copper accent on warm
graphite/paper neutrals, Space Grotesk + Inter + JetBrains Mono) is token-driven.
`packages/preview/src/theme.css` is the single token source; `docs/design-system.md`
documents it. When touching preview or spec-kit CSS, consume `--syn-*` tokens (or the
`--sk-*` aliases) - never hardcode palette hex values in component rules.

## Don'ts

- Don't co-locate session content in the consumer's source tree. Always `.synergy/sessions/`.
- Don't write raw markdown links between specs.
- Don't bypass validation by silencing errors.
- Don't bundle implementation code in the spec — it describes work, agents do work.
- Don't edit `orchestrator.md` to be MDX-flavored — it must stay plain markdown for CLI legibility.
- Don't pin the preview to a port other than 4321 without updating CLAUDE.md and the docs.
- Don't reference phases by numeric prefix in CrossRefs. The slug is the identifier; the prefix is just sort order.
- Don't try to add a `synergy spec` CLI command. Authoring is a skill.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
