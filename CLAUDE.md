# Synergy

A Claude Code plugin for authoring MDX specifications with a live web preview. Agents generate cross-referenced MDX specs in a `.synergy/sessions/<name>/` folder using a reusable spec-kit component library, then preview them in a browser.

See `SYNERGY_PLAN.md` for the full implementation plan and `AGENTS.md` (once written) for spec-authoring rules.

## Layout

- `packages/spec-kit` — MDX component library + JSON schemas + styles.
- `packages/validator` — MDX parse, schema check, cross-ref resolver. CLI: `synergy validate`.
- `packages/preview` — Vite + React app, watches `.synergy/sessions/`, hot reloads on MDX edits.
- `packages/cli` — `synergy` binary: `init`, `spec`, `preview`, `validate`.
- `plugins/claude-code` — Claude Code plugin manifest, skills, commands.
- `examples/` — canonical dogfood sessions.

Codex distribution is **not in v1**. Do not add Codex skill files yet.

## Conventions

- pnpm workspaces. Use `pnpm` not `npm`/`yarn`.
- TypeScript everywhere. Strict mode on.
- One package per concern — do not let preview leak into spec-kit, or vice versa.
- Each MDX session lives in `.synergy/sessions/YYYY-MM-DD-<slug-from-title>/`. Slug max 40 chars, lowercase, hyphenated. Collisions get a `-<6-char-hash>` suffix.
- Preview server runs on **port 4321** (fixed). PID file at `.synergy/preview.pid`. Start is idempotent.
- Cross-references use `<CrossRef to="03-data-model#user-table">`. Validator fails the build on dangling refs.

## Spec-kit usage rules

- **Always prefer core components** over raw markdown for structured info (status, phases, timelines, risks, allocations, cross-refs, charts).
- **Charts:** default to `<Chart kind="...">` (Mermaid). Agents may import other chart libraries when Mermaid is insufficient — document the choice in the session.
- **Session-specific components:** when a reusable shape doesn't exist in spec-kit, create one in the session's `_components/` directory rather than degrading to plain markdown.
- **Orchestrator file:** every session must include an `orchestrator.md` (plain markdown, not MDX) with: Overview, Dependency Graph, Parallel Chunks, Agent Strategy (sub-agents vs teams), Verification Gates.

## Commands

```
synergy init                     scaffold .synergy/ in the cwd
synergy spec [title] [--type]    create a new session (type: feature|refactor|project)
synergy preview <start|stop|status>
synergy validate [session]
```

Claude Code slash commands mirror the CLI: `/synergy-spec`, `/synergy-preview-start`, `/synergy-preview-stop`, `/synergy-preview-status`, `/synergy-validate`.

## What not to do

- Don't add a Next.js or Astro dependency to `packages/preview`. Vite + React + MDX only.
- Don't pin the preview port to anything other than 4321 without updating this file and the plan.
- Don't write raw `[link](other-file.mdx)` markdown links between specs — use `<CrossRef>` so the validator can catch breakage.
- Don't co-locate session content inside `packages/` — sessions live in the consumer project's `.synergy/sessions/`, not in this repo (except the dogfood examples under `examples/`).
