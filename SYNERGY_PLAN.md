# Synergy — Implementation Plan

A Claude Code plugin that ships a spec-authoring skill plus a Vite/React MDX preview server. Agents generate MDX specs that cross-reference each other and render in a browser with hot reload.

**v1 scope:** spec generation + preview + orchestrator file.
**Distribution:** Claude Code plugin only (Codex deferred).

> **Status:** v1 shipped. The current canonical design lives in
> `docs/superpowers/specs/2026-05-23-synergy-multipage-preview-design.md`,
> which supersedes this document on three points: (1) phases are now
> first-class folders, not inline `<Phase>` blocks; (2) the CLI no longer
> has a `synergy spec` command — authoring lives in the `synergy:create-spec`
> and `synergy:spec-authoring` skills; (3) the preview app is multi-page
> with hierarchical sidebar navigation. The notes below are kept for
> historical context; refer to the design doc for current behavior.

## Resolved decisions

1. **Session naming:** `YYYY-MM-DD-<slug-from-title>`. Collisions get a short hash suffix.
2. **Preview port:** fixed at `4321`.
3. **Charts:** default to Mermaid via `<Chart>`. Agents are free to pull any chart library when Mermaid is insufficient — document it in the session.
4. **Codex:** not in v1. All `plugins/codex/` work deferred.

## Repo shape

```
synergy/                              pnpm monorepo
├─ packages/
│  ├─ spec-kit/        MDX component library + JSON schemas + styles
│  ├─ validator/       MDX parse, schema check, cross-ref resolution
│  ├─ preview/         Vite + React app, watches .synergy/sessions/
│  └─ cli/             `synergy` binary: init, preview, validate (authoring is a skill)
├─ plugins/
│  └─ claude-code/     plugin.json, skills/, commands/
├─ examples/refactor-auth/   canonical example session (dogfood)
├─ AGENTS.md           hard rules for agents authoring specs
├─ CLAUDE.md           project memory for Claude Code sessions
└─ README.md
```

## User flow (target UX)

1. User: "build feature X" / "refactor Y" → invokes `/synergy-spec`.
2. Skill prompts for session name (or auto-generates `2026-05-22-<slug>`) and type (`feature|refactor|project`).
3. Brainstorms requirements, then writes `.synergy/sessions/<name>/`:
   - `00-overview.mdx`, `01-architecture.mdx`, … numerically ordered sub-specs.
   - `orchestrator.md` — sequence, parallelizable chunks, sub-agent vs team strategy.
   - `_components/` — session-specific MDX components (optional).
   - `assets/` — diagrams, mockups.
4. Skill auto-starts preview server (PID tracked in `.synergy/preview.pid`), opens browser to the new session.
5. User iterates with the agent; MDX edits hot-reload in browser.
6. To implement: user references `.synergy/sessions/<name>/` and `orchestrator.md` becomes the agent's playbook.

## Spec-kit components (v1)

**Structural:** `<Status>`, `<Phase>`, `<Timeline>`, `<SubSpec>`, `<CrossRef to="01-architecture#auth-flow">`, `<AgentAllocation>`, `<Team>`, `<Reviewer>`, `<OpenQuestion>`, `<Risk severity>`, `<Mockup>`.

**Visual:** `<Chart kind="flow|sequence|architecture|gantt">` rendering Mermaid client-side. Agents may import other chart libs ad-hoc when Mermaid falls short.

Each component: TS props → JSON schema (build-step generated) → validator enforces.

**Session-specific components:** agents create them in `_components/` when reusable shape doesn't fit core kit. AGENTS.md sets the bar: prefer core, but build new components rather than degrade to raw markdown.

## Phased build

| Phase | Deliverable | Parallel-safe after |
|------|------------|---------------------|
| 0 | pnpm monorepo scaffold, TS config, biome, CI typecheck | — |
| 1 | spec-kit: 11 core components + schema gen + styles | 0 |
| 2 | validator: MDX parse, schema check, cross-ref resolver, CLI | 1 |
| 3 | cli: `synergy init\|preview\|validate`, session naming, preview lifecycle (authoring lives in skills) | 1 (parallelizable w/ 2) |
| 4 | preview app: Vite+React, MDX provider, session nav, concatenated page render, file watcher | 1 |
| 5 | plugin packaging: Claude Code `plugin.json`, skills, commands | 3, 4 |
| 6 | AGENTS.md + CLAUDE.md: authoring rules + project memory | 1 |
| 7 | orchestrator.md generation baked into create-spec skill | 5, 6 |
| 8 | dogfood: spec the next Synergy feature using Synergy; ship `examples/` | 7 |

Phases 1 and 6 start immediately after 0. Phases 2/3/4 can run in parallel via sub-agents after Phase 1 lands.

## Key design decisions

- **Single MDX page per session in the preview.** Concatenated `*.mdx` in numeric order with a ToC sidebar — easier to read than tab-switching. Session switcher in top nav.
- **Preview lifecycle = explicit.** `synergy preview start` writes a PID file; create-spec only starts if not already running. `/synergy-preview-stop` kills the server.
- **Cross-refs are validated, not runtime-fragile.** `<CrossRef to="03-data-model#user-table" />` resolves to a slugified heading anchor; validator fails if the target doesn't exist.
- **Orchestrator.md is plain markdown, not MDX.** It's read by agents during implementation, not rendered. Sections: Overview → Dependency Graph → Parallel Chunks → Agent Strategy (sub-agents vs teams) → Verification Gates.

## Session naming

`YYYY-MM-DD-<slug-from-title>` — slug is lowercased, hyphenated, max 40 chars from the user-provided or LLM-generated title. On collision, append `-<6-char-hash>` of the title.

## Preview server

- Port: `4321` (fixed).
- Lifecycle: PID file at `.synergy/preview.pid`. Start is idempotent; checks PID before spawning.
- Routes: `/` redirects to most recently modified session. `/s/<session-name>` renders that session.
- HMR via Vite's file watcher on `.synergy/sessions/**/*.mdx` and `_components/**`.
- MDX provider injects spec-kit components globally; session `_components/*` are auto-imported into that session's scope.

## Plugin surface (Claude Code)

Commands:
- `/synergy-spec [title]` — invoke create-spec skill.
- `/synergy-preview-start`, `/synergy-preview-stop`, `/synergy-preview-status`.
- `/synergy-validate [session]`.

Skills:
- `create-spec` — workflow: brainstorm → name session → generate MDX → start preview → open browser.
- `preview-control` — start/stop/status wrappers.
- `spec-authoring` — loaded by agents when editing specs; enforces component usage rules.

## CLI surface

```
synergy init                          scaffold .synergy/ in cwd
synergy preview <start|stop|status>   long-running preview server (port 4321)
synergy validate [session]            parser + cross-ref check
```

Session creation lives in the `synergy:create-spec` skill (superseded the original `synergy spec` CLI command).

## Effort estimate

- Phase 0–1: ~half day.
- Phase 2–4: ~1–2 days each, parallelizable → ~2 days wall clock.
- Phase 5–7: ~1 day.
- Phase 8: ~half day.

**Total: ~4–5 days** if executed with sub-agents per package post-Phase 1.
