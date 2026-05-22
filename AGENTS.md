# AGENTS.md — Synergy spec authoring

Rules and conventions for any agent (Claude Code, Codex, or otherwise) that authors or edits Synergy MDX spec sessions. Cross-host file — kept in sync with `CLAUDE.md`.

## What Synergy is

A spec-authoring system. Agents generate cross-referenced MDX documents in `.synergy/sessions/<session-name>/` and render them in a Vite + React preview at `http://localhost:4321`. A separate `orchestrator.md` per session tells the implementing agent how to execute the work (sequencing, parallelism, agent strategy).

## Hard rules

1. **Session location.** All spec content lives in `.synergy/sessions/<YYYY-MM-DD-<slug>>/`. Never write spec files anywhere else in the consumer project.
2. **Components over markdown.** Prefer spec-kit components (`<Status>`, `<Phase>`, `<Timeline>`, `<SubSpec>`, `<CrossRef>`, `<AgentAllocation>`, `<OpenQuestion>`, `<Risk>`, `<Mockup>`, `<Chart>`, `<Team>`, `<Reviewer>`) over ad-hoc markdown for structured content.
3. **Build, don't degrade.** When the structure you need doesn't exist in spec-kit, create a session-local component in `_components/` rather than falling back to raw markdown.
4. **CrossRefs are mandatory.** Every spec-to-spec link uses `<CrossRef to="<slug>" />` or `<CrossRef to="<slug>#<anchor>" />`. Do not write `[link](other.mdx)` style markdown links — the validator can't enforce those.
5. **Orchestrator file is required.** Every session has an `orchestrator.md` (plain markdown, not MDX). It describes the dependency graph, parallelizable chunks, sub-agent vs agent-team strategy, and verification gates.
6. **Validator is the gate.** A session is not "ready" until `synergy validate <session>` returns zero errors. Warnings are acceptable but must be reviewed.
7. **Charts.** Default to `<Chart>` (Mermaid). When Mermaid can't express what you need, write a session-local chart component in `_components/` using any library (recharts, visx, react-flow, …).
8. **Preview lifecycle.** The preview server runs on port `4321` only. PID at `.synergy/preview.pid`. Never bypass the CLI — always use `synergy preview start|stop|status`.

## Session structure

```
.synergy/sessions/<YYYY-MM-DD-slug>/
├── 00-overview.mdx          required: status, goals, sub-spec map, open questions, risks
├── 01-architecture.mdx      required: system shape, diagrams
├── 02-implementation.mdx    required: phased build with agent allocation, timeline
├── NN-<custom>.mdx          optional: add more sub-specs as needed, keep NN ordered
├── orchestrator.md          required: implementation playbook
├── _components/             optional: session-local React/MDX components
└── assets/                  optional: images, mockups
```

## Generating a session

```
synergy spec "Add auth middleware" --type feature
```

This:
1. Picks a name (`YYYY-MM-DD-<slug>`), with a 6-char hash suffix if there's a collision.
2. Scaffolds the four required files with templates.
3. Starts the preview server (idempotent).
4. Opens the browser to `http://localhost:4321/s/<session-name>`.

Override with `--name <explicit-name>`. Skip preview/browser with `--no-preview` / `--no-open`.

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

## Don'ts

- Don't co-locate session content in the consumer's source tree. Always `.synergy/sessions/`.
- Don't write raw markdown links between specs.
- Don't bypass validation by silencing errors.
- Don't bundle implementation code in the spec — it describes work, agents do work.
- Don't edit `orchestrator.md` to be MDX-flavored — it must stay plain markdown for CLI legibility.
- Don't pin the preview to a port other than 4321 without updating CLAUDE.md and the docs.
