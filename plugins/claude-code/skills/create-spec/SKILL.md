---
name: create-spec
description: Use when the user wants to plan a new feature, refactor, or project. Generates a Synergy MDX spec session in .synergy/sessions/, auto-starts the preview server, and opens the browser. Triggers on phrases like "create a spec for X", "let's plan Y", "scaffold a refactor for Z", "/synergy-spec".
---

# create-spec

Author a structured MDX spec session for the work the user is about to start. The session lives in `.synergy/sessions/<YYYY-MM-DD-slug>/` and contains:

- `00-overview.mdx` — top-level spec (status, goals, sub-spec links, open questions, risks).
- `01-architecture.mdx` — system shape, diagrams.
- `02-implementation.mdx` — phased build, agent allocation, timeline.
- `orchestrator.md` — plain-markdown playbook the agent reads before implementing.
- `_components/` — empty; use it for session-specific MDX components.
- `assets/` — empty; use it for images, diagrams.

## Workflow

1. **Confirm intent.** Restate the user's request in one sentence and ask one clarifying question if the work type (feature / refactor / project) or scope is ambiguous. Skip the question if it's clear.
2. **Pick a session name.** Default to auto-generated `YYYY-MM-DD-<slug>` from the title. Offer the user a chance to override if they care; most won't.
3. **Generate the session** by running `synergy spec "<title>" --type <feature|refactor|project>` from the project root. The CLI:
   - creates the session folder,
   - writes the four files with sensible templates,
   - auto-starts the preview server on port `4321` (PID tracked in `.synergy/preview.pid`),
   - opens the browser to `http://localhost:4321/s/<session-name>`.
4. **Fill in the templates.** Open the generated `00-overview.mdx`, `01-architecture.mdx`, and `02-implementation.mdx` and replace the placeholder text with the actual spec content based on the conversation. Use spec-kit components liberally — see "Component cheat sheet" below.
5. **Write the orchestrator.** Edit `orchestrator.md`. Specify:
   - dependency graph of phases / chunks,
   - which phases can run in parallel via sub-agents,
   - which need an agent team (multi-step, exploratory),
   - verification gates between phases.
6. **Validate.** Run `synergy validate <session-name>` and fix any reported issues. The validator catches: schema violations on component props, dangling cross-references.
7. **Iterate with the user.** The preview hot-reloads on every MDX save. Take edit requests, modify the files, and let the browser refresh.

## Component cheat sheet

All from `@synergy/spec-kit`. Import at the top of each MDX file.

| Component | When to use |
|---|---|
| `<Status value="draft\|proposed\|in-progress\|blocked\|done\|shipped" />` | Mark the spec or a sub-section's lifecycle stage. |
| `<Phase number title status estimate>` | Wrap each implementation phase. |
| `<Timeline milestones={[...]} />` | Show ordered milestones with optional `when` and `status`. |
| `<SubSpec slug title summary />` | Link to a sibling MDX in the session. |
| `<CrossRef to="01-architecture#section-anchor" />` | Inline reference to another spec or anchor. Validator enforces target exists. |
| `<AgentAllocation entries={[...]} />` | Table of agents (sub-agent / agent-team / human) and what they own. |
| `<Team name members mission />` | Group of contributors with roles. |
| `<Reviewer name role scope handle />` | Single reviewer and their sign-off scope. |
| `<OpenQuestion id question owner resolveBy />` | Unresolved decision blocking progress. |
| `<Risk id title severity category mitigation />` | Known hazard with mitigation. |
| `<Mockup src alt caption />` | Embed an image from `assets/`. |
| `<Chart kind="flow\|sequence\|state\|er\|gantt\|mindmap\|architecture">{`mermaid source`}</Chart>` | Mermaid-rendered diagram. Use for any visual you can express in Mermaid. |

For visual layouts beyond Mermaid (custom React-flow, recharts, etc.), an agent may add new components in `_components/` for that session and import them locally.

## Cross-reference syntax

`<CrossRef to="<spec-slug>" />` — link to another file in the session.
`<CrossRef to="<spec-slug>#<heading-slug>" />` — link to a specific heading. Heading slugs are GitHub-style: lowercased, spaces → `-`, special chars stripped.

The validator resolves every `to=` at build time. If you reference a missing slug or anchor, validation fails.

## Hard rules

- **Prefer spec-kit components over raw markdown** for structured content (status, phases, risks, allocations, timelines, charts).
- **Always include `orchestrator.md`.** Without it, agents implementing the spec don't know the execution strategy.
- **Charts:** default to `<Chart>` (Mermaid). When Mermaid can't express what's needed, build a session-local component in `_components/` and import it.
- **Don't write raw `[link](other.mdx)` between specs** — use `<CrossRef>` so the validator can catch breakage.
- **Don't co-locate the session in the consumer's source tree** — `.synergy/sessions/` is the single home.

## Stop conditions

You're done with this skill when:

- the session exists in `.synergy/sessions/`,
- all placeholder text in the templates has been replaced with real content,
- `synergy validate <session-name>` reports zero errors,
- `orchestrator.md` describes the implementation strategy (not just the spec),
- the user confirms the spec reflects their intent.

After that, hand off to the user. They will reference the session in a future conversation to implement it.
