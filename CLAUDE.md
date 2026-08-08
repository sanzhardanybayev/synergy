# Synergy

A cross-host planning and guided code-review toolkit with a live web preview. Agents author cross-referenced MDX specs in `.synergy/sessions/<name>/` or guide human review of immutable Git-backed revisions in `.synergy/reviews/<workspace>/`.

See `SYNERGY_PLAN.md` for the original implementation plan and `AGENTS.md` for cross-host authoring and review rules.

## Layout

- `packages/spec-kit` — MDX component library + JSON schemas + styles.
- `packages/validator` — MDX parse, schema check, cross-ref resolver. CLI: `synergy validate`.
- `packages/preview` — Vite + React app, watches `.synergy/sessions/`, hot reloads on MDX edits.
- `packages/cli` — deterministic project, preview, validation, execution-state, and review-artifact commands. Agent reasoning lives in skills.
- `skills` — shared agent workflows used by Claude Code and Codex.
- `commands` — thin Claude Code command shims that dispatch to shared skills.
- `packages/vscode-extension` — VS Code/Cursor review pane; local .vsix, bundles review-core.
- `examples/` — canonical dogfood sessions.

Keep shared workflow logic in root skills. Claude commands must remain thin dispatch shims.

## Conventions

- pnpm workspaces. Use `pnpm` not `npm`/`yarn`.
- Preview styling is token-driven ("Ember & Graphite"). Tokens live in `packages/preview/src/theme.css`; see `docs/design-system.md`. Never hardcode palette hex values in preview or spec-kit component CSS.
- TypeScript everywhere. Strict mode on.
- One package per concern — do not let preview leak into spec-kit, or vice versa.
- Each MDX session lives in `.synergy/sessions/YYYY-MM-DD-<slug-from-title>/`. Slug max 40 chars, lowercase, hyphenated. Collisions get a `-<6-char-hash>` suffix.
- Phases live as first-class folders: `phases/<NN>-<slug>/spec.mdx` (required) + `orchestrator.md` (optional). `NN` is a zero-padded ordering integer; the slug is the stable identifier. Renumbering folders does not break cross-refs.
- Preview startup prefers **port 4321** and selects a reachable alternate when needed. Runtime state records the verified origin; start is idempotent.
- Cross-references use `<CrossRef to="03-data-model#user-table">` for sibling specs and `<CrossRef to="phases/<slug>" />` for phase folders (slug, not numeric prefix). Validator fails the build on dangling refs and warns on legacy phase forms like `02-implementation#phase-N`.
- Spec authoring is owned by skills (`synergy:create-spec` for new sessions, `synergy:spec-authoring` for edits). There is no `synergy spec` CLI command — the CLI only handles process operations (`init`, `preview`, `validate`).

## Spec-kit usage rules

- **Always prefer core components** over raw markdown for structured info (status, phases, timelines, risks, allocations, cross-refs, charts).
- **Charts:** default to `<Chart kind="...">` (Mermaid). Agents may import other chart libraries when Mermaid is insufficient — document the choice in the session.
- **Session-specific components:** when a reusable shape doesn't exist in spec-kit, create one in the session's `_components/` directory rather than degrading to plain markdown.
- **Orchestrator file:** every session must include an `orchestrator.md` (plain markdown, not MDX) with: Overview, Dependency Graph, Parallel Chunks, Agent Strategy (sub-agents vs teams), Verification Gates.
- **Agent roster:** declare agents in `<AgentTree>` — the single source of truth for the
  hierarchy and per-agent model/effort. Effort **inherits** down the tree (omit to inherit
  the parent's); model is **per-node** (no inheritance). Apply the quality-first rubric:
  start at `opus`, drop a tier only when the task is provably bounded AND verified
  downstream. `<AgentAllocation>` is slimmed to agent→phase ownership (name + phases only,
  no model/effort/count). `<Phase>` references agents by name; look up effort in the tree.
  The preview lets you edit effort (inheriting) and model (per-node) and **Save** writes
  back into the `<AgentTree>` source. Use `subAgents` (not `children`) for nesting nodes.
- **Live-bound status:** components that show execution status must read it from
  live state, never hardcode it. `<Timeline />` (no `milestones`) renders the
  phase roster and progress bar from execution state — the same source the
  right-rail progress drawer uses, so the two never diverge. `<Phase id="…">`
  overlays live status the same way. Only use the legacy `<Timeline milestones={…}>`
  form for documentation timelines that are not tied to phases.

## Inline editing and feedback (v2)

The preview origin reported by `synergy preview status --json` supports direct editing without a Claude round-trip:

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
- **Live feedback loop.** `synergy feedback wait <session> [--for 10m]` blocks until open
  comments exist (queued ones return immediately), the browser's **Done reviewing** button
  drops the `.review-done` control file (`status: "ended"`, final comments ride along), or
  the bounded wait expires. The CLI watches `.synergy/feedback/<session>/` directly, so it
  works without the preview server. `GET /api/feedback/stream` (SSE) notifies the preview
  of comment-file changes so agent resolutions appear live; the skill's Live wait mode owns
  the agent-side loop contract. While waiting, the CLI maintains a `.listening` heartbeat
  marker (30s touch, removed on exit); the stream reports it as `presence` frames
  (mtime fresh within 90s) and the comments panel shows "Agent listening" / "No agent".
- **New gitignored files.** `active-session` (tracks the currently-viewed session) and
  `review-state.json` (per-user diff-review cursor) are gitignored. The `sessions/` and
  `feedback/` directories remain tracked.

## Execution state and hand-off (v3)

Every session has a `.state/` sidecar **committed to git** — it is the shared hand-off record for agents and humans:

- `progress.json` — phase list with per-phase statuses + the `resume` pointer. Overall progress is **derived** (never stored); the file is the source of truth.
- `phases/<slug>.md` — per-phase journal written by `phase set --note` and `log --phase`.
- `journal.md` — cross-cutting findings written by `log --global`.
- `resume` in `progress.json` — the hand-off pointer (`nextPhase` + free-text `note`) a fresh agent reads first before touching anything else.
- `handoff.md` — a latest-wins KT baton written by `/synergy-handoff` when you stop
  mid-work. Both `synergy:execute` and `synergy:continue` read it FIRST; it carries
  sub-phase state (what's half-done, the next concrete step) that the phase-gated journals
  miss. Overwritten on each capture; git-committed like the rest of `.state/`.

Every `<Phase>` should carry a stable `id` (slug, e.g. `id="storage"`). Execution state keys on that slug. The validator emits a warning when `id` is absent.

CLI commands:

```
synergy phase set <session> <phaseId> <status> [--note <text>]   record phase status + optional boundary note
synergy log <session> <text> (--phase <id> | --global)           append a finding to a phase or global journal
synergy continue <session> [--next <phaseId>] [--note <text>]    write the hand-off pointer
synergy handoff <session> [--next <id>] [--body <text> | --body-file <path>]   write the KT handoff baton (.state/handoff.md) + resume pointer
synergy status <session>                                          print progress rollup (phases done / total)
```

Skills + slash commands:
- `synergy:execute` (`/synergy-execute`) — disciplined execution loop; **mandatory state-write gate**: the skill calls `phase set` + `log` before it may proceed past a phase boundary. Accepts run-time directives (scope, model/effort overrides) after the session name; these layer above the stored plan and do NOT mutate it.
- `synergy:continue` (`/synergy-continue`) — fresh-context entry point; reads the `resume` pointer first, then picks up from `nextPhase`. Also accepts run-time directives.

`<AgentTree>` nodes carry per-agent `model`/`effort` (effort inherits from the nearest ancestor; model is per-node) and optional `count`; the execute skill resolves them by agent name when spawning sub-agents or teams.

## Daemon HTTP API (performance path)

When the preview server is running, agents and skills SHOULD use these endpoints at the
verified origin from `synergy preview status --json` instead of spawning `node cli.js`
(~55 ms/call) — they reuse the warm process and a mtime-keyed parse cache:

| Method + path | Replaces | Body / query |
|---|---|---|
| `POST /api/phase` | `synergy phase set` | `{session, phaseId, status, note?}` |
| `POST /api/log` | `synergy log` | `{session, text, phase?, global?}` |
| `POST /api/resume` | `synergy continue` | `{session, next?, note?}` |
| `POST /api/handoff` | `synergy handoff` | `{session, body, next?}` |
| `GET /api/validate?session=` | `synergy validate` | — (returns ValidationReport JSON) |
| `GET /api/progress?session=` | `synergy status` | — |
| `POST /api/scaffold` | per-file mkdir/write in create-spec | `{session, dirs?, files:[{path,content}]}` |
| `POST /api/feedback/resolve-batch` | per-comment PATCH loop | `{items:[{id,status,resolution?,rejection_reason?}]}` |

All endpoints write the SAME git-committed `.state/` and `feedback/` files as the CLI.
When the preview is down, fall back to the `node cli.js …` command.

## Commands

```
synergy init                          scaffold .synergy/ in the cwd
synergy preview <start|stop|status>   long-running preview server (prefers port 4321)
synergy validate [session]            parser + cross-ref check
synergy phase set <session> <id> <status> [--note <text>]   record phase transition
synergy log <session> <text> (--phase <id> | --global)      append finding to journal
synergy continue <session> [--next <id>] [--note <text>]    write hand-off pointer
synergy handoff <session> [--next <id>] [--body <text> | --body-file <path>]   write the KT handoff baton (.state/handoff.md) + resume pointer
synergy status <session>                                     print execution-state rollup
synergy feedback wait <session> [--for <dur>]                block until review comments arrive (or Done reviewing / timeout)
synergy review create (--pr <n|url> | --staged | --unstaged | --scope <path>) [--json]
synergy review refresh <workspaceId>
synergy review analysis-set <workspace@revision> --body-file <path>
synergy review list [--json]
synergy review open <workspace@revision> [--json]   return the verified runtime's full URL
synergy review status <workspace@revision> [--json]
synergy review wait <workspace@revision> [--for <dur>]
synergy review answer <questionId> --review <workspace@revision> --body-file <path>
```

Spec authoring is not a CLI command — invoke the `synergy:create-spec` skill (or `/synergy-spec` slash command, which dispatches to the skill).

## Guided code review (v4)

Review is separate from specification sessions. Invoke `synergy:review` directly in Claude
Code or Codex; `/synergy-review` is only a Claude Code shim. Supported sources are a GitHub
PR, staged changes, unstaged changes, and a bounded current-code scope.

- Immutable artifacts live under `.synergy/reviews/<workspace>/revisions/<revision>/` and
  render at `/r/<workspace>/<revision>`. `.synergy/active-review.json` tracks browser activity.
  Both paths are gitignored local state.
- Identical captures resume the same revision. `review refresh <workspace>` reconciles a
  changed source into a new revision, carrying only deterministically unchanged items.
- Agents inspect repository context to group items and write one/two-sentence descriptions;
  the CLI owns capture, fingerprints, schema validation, persistence, and readiness.
- Browser questions are durable. The agent runs `review wait` in the foreground, answers the
  exact revision through `review answer`, then waits again. It never changes application code
  merely because a question was asked.

Claude Code slash commands: `/synergy-spec` (skill), `/synergy-review` (skill), `/synergy-preview-start`, `/synergy-preview-stop`, `/synergy-preview-status`, `/synergy-validate`, `/synergy-feedback` (skill), `/synergy-execute` (skill), `/synergy-continue` (skill), `/synergy-handoff` (skill).

## Release & freshness

- `.claude-plugin/plugin.json` `version` is the single source of truth. **Never
  hand-edit** `marketplace.json` or the `synergy-version` stamp / `MINE` literal in
  any `SKILL.md` — lefthook runs `version-sync` on commit to derive them all from
  `plugin.json`. (`packages/plugin-guard` owns this tooling.)
- A behavior change under `skills/`, `packages/`, `commands/`, or `hooks/` **must**
  bump the version; the CI `release-gate` job fails the PR otherwise. `examples/`
  and `docs/` are exempt.
- A `SessionStart` hook (`hooks/session-start.sh`) and a Step-0 check in the
  authoring skills **warn (and proceed)** when a session is running an older
  version than is installed on disk. Both are fix-forward (effective from the
  version that ships them) and fail open.

## What not to do

- Don't add a Next.js or Astro dependency to `packages/preview`. Vite + React + MDX only.
- Don't treat the preferred port `4321` as authoritative; use the verified runtime origin.
- Don't write raw `[link](other-file.mdx)` markdown links between specs — use `<CrossRef>` so the validator can catch breakage.
- Don't reference phases by their numeric prefix in CrossRefs (`phases/01-core` is wrong). Use the slug only: `<CrossRef to="phases/core" />`. The numeric prefix is for sort order, not identity.
- Don't reintroduce `synergy spec` as a CLI command. The skill is the contract.
- Don't co-locate session content inside `packages/` — sessions live in the consumer project's `.synergy/sessions/`, not in this repo (except the dogfood examples under `examples/`).
