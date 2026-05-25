# Synergy

A Claude Code plugin for authoring MDX specifications with a live web preview. Agents generate cross-referenced MDX specs in a `.synergy/sessions/<name>/` folder using a reusable spec-kit component library, then preview them in a browser.

See `SYNERGY_PLAN.md` for the full implementation plan and `AGENTS.md` (once written) for spec-authoring rules.

## Layout

- `packages/spec-kit` — MDX component library + JSON schemas + styles.
- `packages/validator` — MDX parse, schema check, cross-ref resolver. CLI: `synergy validate`.
- `packages/preview` — Vite + React app, watches `.synergy/sessions/`, hot reloads on MDX edits.
- `packages/cli` — `synergy` binary: `init`, `preview`, `validate`. Spec authoring lives in skills.
- `plugins/claude-code` — Claude Code plugin manifest, skills, commands.
- `examples/` — canonical dogfood sessions.

Codex distribution is **not in v1**. Do not add Codex skill files yet.

## Conventions

- pnpm workspaces. Use `pnpm` not `npm`/`yarn`.
- TypeScript everywhere. Strict mode on.
- One package per concern — do not let preview leak into spec-kit, or vice versa.
- Each MDX session lives in `.synergy/sessions/YYYY-MM-DD-<slug-from-title>/`. Slug max 40 chars, lowercase, hyphenated. Collisions get a `-<6-char-hash>` suffix.
- Phases live as first-class folders: `phases/<NN>-<slug>/spec.mdx` (required) + `orchestrator.md` (optional). `NN` is a zero-padded ordering integer; the slug is the stable identifier. Renumbering folders does not break cross-refs.
- Preview server runs on **port 4321** (fixed). PID file at `.synergy/preview.pid`. Start is idempotent.
- Cross-references use `<CrossRef to="03-data-model#user-table">` for sibling specs and `<CrossRef to="phases/<slug>" />` for phase folders (slug, not numeric prefix). Validator fails the build on dangling refs and warns on legacy phase forms like `02-implementation#phase-N`.
- Spec authoring is owned by skills (`synergy:create-spec` for new sessions, `synergy:spec-authoring` for edits). There is no `synergy spec` CLI command — the CLI only handles process operations (`init`, `preview`, `validate`).

## Spec-kit usage rules

- **Always prefer core components** over raw markdown for structured info (status, phases, timelines, risks, allocations, cross-refs, charts).
- **Charts:** default to `<Chart kind="...">` (Mermaid). Agents may import other chart libraries when Mermaid is insufficient — document the choice in the session.
- **Session-specific components:** when a reusable shape doesn't exist in spec-kit, create one in the session's `_components/` directory rather than degrading to plain markdown.
- **Orchestrator file:** every session must include an `orchestrator.md` (plain markdown, not MDX) with: Overview, Dependency Graph, Parallel Chunks, Agent Strategy (sub-agents vs teams), Verification Gates.

## Inline editing and feedback (v2)

The preview at `http://localhost:4321` supports direct editing without a Claude round-trip:

- **Apply / Discard editing.** Prose blocks (paragraphs, list items, headings) are
  contentEditable. Edits live in an in-browser buffer until explicitly applied via **Apply**
  (writes to the MDX file) or discarded via **Discard** (reverts). Phase status dropdowns use
  the same buffer pattern. There is no auto-save.
- **Inline comments.** Select any text in the preview, click the "+" button, and leave a
  note for Claude. Comments are stored as markdown files at
  `.synergy/feedback/<session>/<id>.md` with a YAML frontmatter anchor (line/col + context).
- **Diff view.** Top-toolbar toggle. Shows changes since the last "Mark as reviewed" action
  (committed and uncommitted hunks). Reviewing syncs to `.synergy/review-state.json`.
- **Feedback handoff.** Run `/synergy-feedback` in Claude Code. The `synergy:address-feedback`
  skill reads the comment queue for the browser-active session, edits each referenced spec
  location, and PATCHes each comment to resolved or rejected.
- **New gitignored files.** `active-session` (tracks the currently-viewed session) and
  `review-state.json` (per-user diff-review cursor) are gitignored. The `sessions/` and
  `feedback/` directories remain tracked.

## Commands

```
synergy init                          scaffold .synergy/ in the cwd
synergy preview <start|stop|status>   long-running preview server (port 4321, PID-tracked)
synergy validate [session]            parser + cross-ref check
```

Spec authoring is not a CLI command — invoke the `synergy:create-spec` skill (or `/synergy-spec` slash command, which dispatches to the skill).

Claude Code slash commands: `/synergy-spec` (skill), `/synergy-preview-start`, `/synergy-preview-stop`, `/synergy-preview-status`, `/synergy-validate`, `/synergy-feedback` (skill).

## What not to do

- Don't add a Next.js or Astro dependency to `packages/preview`. Vite + React + MDX only.
- Don't pin the preview port to anything other than 4321 without updating this file and the plan.
- Don't write raw `[link](other-file.mdx)` markdown links between specs — use `<CrossRef>` so the validator can catch breakage.
- Don't reference phases by their numeric prefix in CrossRefs (`phases/01-core` is wrong). Use the slug only: `<CrossRef to="phases/core" />`. The numeric prefix is for sort order, not identity.
- Don't reintroduce `synergy spec` as a CLI command. The skill is the contract.
- Don't co-locate session content inside `packages/` — sessions live in the consumer project's `.synergy/sessions/`, not in this repo (except the dogfood examples under `examples/`).
