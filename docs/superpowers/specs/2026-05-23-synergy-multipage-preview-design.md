# Synergy: multi-page preview, phases-as-folders, skill-first authoring

**Status:** approved — ready for implementation planning. Shipped; visual details in the mockups below (emoji glyphs, the "Orchestrator (root)" label, colors) predate the "Ember & Graphite" redesign — `docs/design-system.md` owns the current visual language.
**Date:** 2026-05-23
**Author:** Sanzhar + Claude (brainstorming session)
**Affects:** `packages/preview`, `packages/cli`, `packages/validator`, `packages/spec-kit`, Claude Code skills under `skills/synergy/*`, `CLAUDE.md`, `README.md`

## 1. Summary

Synergy's preview today renders an entire spec session as one long scroll, with a single root orchestrator and all phases inlined into `02-implementation.mdx`. This design replaces that with:

1. **Phases as first-class folders** — each phase gets its own `spec.mdx` + `orchestrator.md`, mirroring how the root session is structured.
2. **Multi-page preview app** — one route per file, hierarchical left sidebar (phases nest under Implementation), copy-path buttons in every page header, slide-out drawer for orchestrators with rendered markdown.
3. **Skill-first spec authoring** — the `synergy spec` CLI command is removed; the `create-spec` and `spec-authoring` skills become the canonical authoring contract. Templates live next to the skills. The CLI keeps only operations that need a process: `init`, `preview`, `validate`.

The goal is to make Synergy specs scale to multi-phase, multi-agent work without losing the lightweight feel for one-off ad-hoc plans.

## 2. Goals

- Make the unit of work that can be handed to an agent crisp: an agent can be pointed at `phases/02-core/` as one self-contained mini-session with its own spec and orchestrator.
- Let humans navigate large plans quickly via hierarchical left nav, with the option to read a page at a time instead of one giant scroll.
- Make it trivial to copy paths an agent needs (session folder, current page, current orchestrator) so users can paste them into agent prompts without manual typing.
- Keep the surface area lean: collapse spec-authoring into the skill instead of carrying parallel CLI + skill implementations.
- Preserve the lightweight option: a tiny ad-hoc spec is still just `00-overview.mdx` + `orchestrator.md`. The new structure shouldn't add ceremony for small work.

## 3. Non-goals

- No mobile-first redesign. A cheap `display: none` for the sidebar under 720px is acceptable; no nav drawer animation.
- No backwards compatibility CLI for `synergy spec` or `synergy phase add`. The skill is the authoring path; non-Claude users read the templates and copy them by hand.
- No automatic CLI migration of old sessions. The one existing dogfood session (`2026-05-22-readme-s-tier`) is hand-rewritten as part of execution.
- No Codex distribution work. Same scope as v1.

## 4. Locked decisions

Captured during the 2026-05-23 brainstorming session:

| Decision | Choice | Rationale |
|---|---|---|
| Session structure | Phases as folders | Symmetric with the root layout; each phase is a mini-session |
| Left nav shape | Hierarchical (phases nest under Implementation) | Matches on-disk; scales to many phases |
| Overview page content | Beefier ("north-star") template | Lets readers brief themselves without drilling in |
| Required overview sections | Summary + Goals only | Don't force structure on small specs |
| Default scaffold | Full structural scaffold (validator stays permissive) | Easier to prune than to remember what's available |
| Phase count in scaffold | **Not** pre-allocated — agent decides from request scope | Phase count is a judgment call, not a default |
| Authoring surface | Skill is canonical; CLI keeps only process operations | One contract, no parallel implementations |
| Orchestrator file format | Plain markdown (unchanged) — but now rendered, not raw | Readability without coupling to MDX components |
| Orchestrator panel UX | Slide-out drawer (right side) | Stays out of the way; ESC + click-backdrop to close |
| Copy buttons | Session path, current page path, current orchestrator path | Three buttons, in page header |
| CrossRef stability | Slug is the identifier, not the numeric prefix | Renumbering phases doesn't break refs |

## 5. Detailed design

### 5.1 On-disk session layout

```
.synergy/sessions/<name>/
├── orchestrator.md              REQUIRED. Root: across-phase sequencing.
├── 00-overview.mdx              REQUIRED. Summary + Goals at minimum.
├── 01-architecture.mdx          OPTIONAL. System diagrams, components.
├── 02-implementation.mdx        OPTIONAL. Timeline, agent allocation, phase index.
├── _components/                 Session-local MDX components (unchanged).
├── assets/                      Screenshots, GIFs (unchanged).
└── phases/                      OPTIONAL. Empty or omitted for non-phased specs.
    ├── 01-<slug>/
    │   ├── spec.mdx             REQUIRED if folder exists.
    │   └── orchestrator.md      OPTIONAL but warned-on-miss.
    ├── 02-<slug>/
    └── ...
```

**Phase folder naming:** `<NN>-<slug>` where `NN` is a zero-padded two-digit ordering integer and `slug` is kebab-case (max 40 chars) derived from the phase title.

**The slug is the stable identifier.** Numeric prefixes provide ordering only. CrossRefs reference the slug: `<CrossRef to="phases/core">` resolves to whichever folder has slug `core` regardless of its numeric prefix. Renumbering phases (e.g. inserting a new one between existing phases) is safe.

**Minimal session:** just `orchestrator.md` + `00-overview.mdx`. Everything else is optional.

### 5.2 Routing

| URL pattern | Renders |
|---|---|
| `/s/<session>` | redirect to `/s/<session>/overview` |
| `/s/<session>/overview` | `00-overview.mdx` |
| `/s/<session>/architecture` | `01-architecture.mdx` (404 if missing) |
| `/s/<session>/implementation` | `02-implementation.mdx` (404 if missing) |
| `/s/<session>/phases/<slug>` | `phases/<NN>-<slug>/spec.mdx` |

Orchestrators are **not** routes. They open as a slide-out drawer from any page. The drawer is keyed by which page you opened it from (root orchestrator from overview/architecture/implementation pages; phase orchestrator from phase pages).

`<CrossRef>` semantics:
- New form: `phases/<slug>#<anchor>` — resolves against current phase slugs.
- Legacy form: `<file-without-ext>#<anchor>` — still works for non-phase cross-refs (overview ↔ architecture, etc.).
- Validator emits a warning if it encounters `02-implementation#phase-N` style (legacy phase ref) and points to the new form.

### 5.3 Left sidebar

```
┌──────────────────────────┐
│ ⌬ Synergy                │  Brand
├──────────────────────────┤
│ Session ▾                │  Dropdown of all sessions (newest first)
│ readme-s-tier            │
├──────────────────────────┤
│ Spec                     │
│  • Overview              │  Active row: accent + background
│    Architecture          │  (Hidden if file missing)
│    Implementation  ▾     │  Chevron toggle separate from row click
│      Phase 1 — Found.    │  (Auto-expand when on /implementation or
│      Phase 2 — Core      │   any /phases/* route)
│      Phase 3 — Polish    │
├──────────────────────────┤
│ 📎 Orchestrator (root)   │  Click → opens slide-out
└──────────────────────────┘
```

- `position: sticky; top: 0; height: 100vh` so the sidebar persists during scroll.
- Rows for files that don't exist in the session are not rendered. A minimal session shows only `Overview` and `Orchestrator`.
- Phase label format: `Phase <number> — <title>`. Number comes from the numeric prefix; title from the phase's `spec.mdx` frontmatter `title:` field.
- Session dropdown: click expands a list of all sessions sorted by `lastModified` descending.

### 5.4 Page header

Every routed page renders the same header:

```
┌────────────────────────────────────────────────────────────────────┐
│ <Page Title>                            [📋 Session path]          │
│ <relative file path>                    [📋 Current page path]     │
│                                         [📋 Orchestrator path]     │
└────────────────────────────────────────────────────────────────────┘
```

Three copy buttons, contextual:

| Button | Copies |
|---|---|
| Session path | Absolute path to `.synergy/sessions/<name>/` |
| Current page path | Absolute path to the file being rendered |
| Orchestrator path | Root `orchestrator.md` on overview/architecture/implementation pages. On a phase page: `phases/<NN>-<slug>/orchestrator.md` if it exists, otherwise fall back to the root orchestrator. |

Click feedback: a "Copied!" toast in the top-right corner for 2 seconds. No system clipboard prompt — uses the browser Clipboard API.

### 5.5 Orchestrator slide-out

Click the orchestrator entry in the sidebar (or a phase-page button), and a drawer slides in from the right covering 60% of the viewport (full-width on narrow screens). The drawer header:

```
Orchestrator — Phase 2 — Core               [📋 Copy path]  [✕]
```

Body: the orchestrator markdown rendered as actual markdown via a small renderer (`react-markdown` or equivalent). Headings, lists, code blocks, tables — all rendered. Plain markdown only; no MDX components in orchestrators.

Close interactions: backdrop click, ESC key, ✕ button. State is local to the page (not URL-tracked).

If the markdown parser throws (corrupted file, etc.), fall back to a `<pre><code>` block with the raw source so the user always sees something.

### 5.6 Per-phase orchestrator semantics

| | Root `orchestrator.md` | Phase `orchestrator.md` |
|---|---|---|
| Scope | The whole session | A single phase |
| Owns | Dependency graph of *phases*; whole-session verification gates; high-level agent strategy ("phases 1–2 by sub-agents, phase 3 by human") | Dependency graph of *sub-tasks within this phase*; sub-agent task assignment within the phase; phase-end verification gate; how to invoke this phase as a unit |
| Reads like | "Phase 1 must land before 2 and 3 can start in parallel. Both are sub-agent-owned." | "Within Phase 2, the migration script and the test rewrite are parallel sub-agents. Verification: migrations green + tests green." |

Both `.md`, both rendered in the slide-out, both have a "Copy path" button.

### 5.7 Skill-first authoring

The CLI command `synergy spec` is removed. Authoring lives in two skills:

**`synergy:create-spec`** — handles new sessions.

Skill body has three parts:

- **Scope reasoning prompt.** Before scaffolding anything, the agent decides: is this a tiny note, a single-phase plan, or a multi-phase plan? Decision is based on the user's request + any cues about scope.
- **Templates.** Concrete starter content lives at `<skill-dir>/templates/`:
  ```
  templates/
  ├── overview-minimal.mdx     Summary + Goals only
  ├── overview-full.mdx        All suggested sections
  ├── architecture.mdx
  ├── implementation.mdx
  ├── orchestrator-root.md
  ├── phase/
  │   ├── spec.mdx
  │   └── orchestrator.md
  ```
- **Layout rules.** Directory structure, slug generation, phase numbering, CrossRef format — stated explicitly so agents don't drift.

Scaffolding procedure for the agent:
1. Read the user's request.
2. Decide: tiny, single-phase, or multi-phase?
3. Generate session slug from title (`YYYY-MM-DD-<kebab-slug>`, max 40 chars in slug part, append `-<6-char-hash>` on collision).
4. Create the session directory and assets/_components subdirectories.
5. Copy templates appropriate to the scope decision, filling placeholders from the user's request.
6. For each phase the agent decides on, copy phase templates into `phases/<NN>-<slug>/`.
7. Call `synergy preview start` via Bash. Print the session URL (`http://localhost:4321/s/<session>/overview`) for the user. Browser-open is best-effort and OS-dependent — the URL print is the contract.

**`synergy:spec-authoring`** — handles edits to existing sessions, including:

- Adding a phase: create `phases/<NN>-<slug>/` from templates; auto-number based on max existing prefix.
- Inserting a phase between existing ones: renumber downstream folders by `mv`-ing them; update any CrossRefs that referenced the moved phases by slug (slugs are stable, so refs that already use the new slug-based form don't need updating).
- Removing a phase: delete folder, renumber downstream phases, prune dangling CrossRefs (warn).
- Renaming a phase: rename the folder (preserving prefix); since slug is the CrossRef key, downstream refs need updating.

### 5.8 Overview content rules

Validator-required headings in `00-overview.mdx`:
- `## Summary`
- `## Goals`

Validator-silent on missing optional sections: Tech stack, High-level plan, Timeline, Sub-specs, Open questions, Risks. The default full scaffold writes all of them; authors prune what's not needed.

### 5.9 Validator changes

- **Required headings** in `00-overview.mdx`: `## Summary`, `## Goals`. Missing either → error.
- **Phase folder naming**: `<NN>-<slug>`, no duplicate `NN`, no gaps in the `NN` sequence. Slug must be kebab-case, max 40 chars. (Gap-free `NN` ensures phase numbers in the UI ("Phase 1", "Phase 2") match the position in the dependency graph — a phase 1 + phase 3 with no phase 2 is a renumbering bug, not a deliberate skip.)
- **Phase folder contents**: `spec.mdx` required; `orchestrator.md` optional (warn on miss).
- **CrossRef resolution**:
  - `phases/<slug>` form: validate against current phase slugs.
  - Legacy non-phase form: validate against current files.
  - Legacy phase form (`02-implementation#phase-N`): resolves if file + anchor exist; warn that the new form is preferred.
- **No new errors on existing minimal sessions** beyond the Summary/Goals check.

### 5.10 Final CLI surface

```
synergy init                          one-shot project scaffold (.synergy/ directory)
synergy preview start|stop|status     long-running preview server (needs PID, port)
synergy validate [session]            parser + cross-ref check (CI / pre-commit)
```

That is the entire CLI. `synergy spec` is removed (`packages/cli/src/spec.ts` deleted; command unregistered in `cli.ts`). No new `synergy phase` subcommand family.

### 5.11 Preview app — file-level changes

| File | Change |
|---|---|
| `packages/preview/src/App.tsx` | Adopt nested routes. Layout: `<Sidebar />` + `<main>` with the routed page. |
| `packages/preview/src/SessionNav.tsx` | Renamed to `Sidebar.tsx`. Now a left-side hierarchical nav (sessions dropdown, spec rows, phases under Implementation, orchestrator entry). |
| `packages/preview/src/PageHeader.tsx` | NEW. Page title + relative path + three copy buttons. |
| `packages/preview/src/CopyButton.tsx` | NEW. Encapsulates clipboard write + "Copied!" toast. |
| `packages/preview/src/OrchestratorDrawer.tsx` | Reworked from `OrchestratorPanel.tsx`. Slide-out drawer with rendered markdown via `react-markdown`. Handles ESC + backdrop click. |
| `packages/preview/src/pages/OverviewPage.tsx` | NEW. Renders `00-overview.mdx`. |
| `packages/preview/src/pages/ArchitecturePage.tsx` | NEW. |
| `packages/preview/src/pages/ImplementationPage.tsx` | NEW. |
| `packages/preview/src/pages/PhasePage.tsx` | NEW. Receives phase slug from route params. |
| `packages/preview/vite-plugin-sessions.ts` | Extend `SessionMeta` to include phase metadata. Emit per-phase loaders for `spec.mdx` and `orchestrator.md`. Emit absolute paths so the page header can show + copy them. |
| `packages/preview/src/sessions.d.ts` | Extend types: phases, paths. |
| `packages/preview/src/app.css` | Sidebar layout, page header, drawer animation, toast. |
| `packages/preview/package.json` | Add `react-markdown` dependency. |

### 5.12 Spec-kit changes

The `<Phase>` component currently expects to be used inline in `02-implementation.mdx`. With phases as folders, `<Phase>` is no longer the primary phase carrier — each phase folder *is* a phase. But `<Phase>` stays in the spec-kit for use in the phase index inside `02-implementation.mdx` (where it summarizes a phase and cross-refs to the phase folder).

Net: no breaking changes to existing spec-kit components. The `<Phase>` component's semantics shift from "this is a phase" to "this is a phase summary card that cross-refs the real phase folder."

### 5.13 Skill template files

The plugin ships these template files under each skill's `templates/` subdirectory. They are read by the agent at scaffold time, not by the CLI.

`overview-minimal.mdx`:
```mdx
---
title: '{{TITLE}}'
type: {{TYPE}}
---

# {{TITLE}}

## Summary

_One paragraph: what's being built and why._

## Goals

- _What success looks like._
- _Out of scope: ..._
```

`overview-full.mdx`: adds Tech stack, High-level plan (with cross-refs to phases), Timeline (uses `<Timeline>` component), Sub-specs, Open questions, Risks.

`phase/spec.mdx`:
```mdx
---
title: '{{PHASE_TITLE}}'
order: {{PHASE_NUMBER}}
---

import { CrossRef } from '@synergy/spec-kit';

# Phase {{PHASE_NUMBER}}: {{PHASE_TITLE}}

## Goal

_What this phase accomplishes._

## Tasks

1. ...
2. ...

## Verification

- _What confirms this phase is done._

## Dependencies

- _What must land first._ See <CrossRef to="phases/<prev-slug>" /> for context if applicable.
```

`phase/orchestrator.md`:
```md
# Phase {{PHASE_NUMBER}} Orchestrator — {{PHASE_TITLE}}

## Within-phase sequencing

_How tasks within this phase order._

## Parallel chunks

- _Which tasks can run as parallel sub-agents._

## Agent strategy

- _Sub-agent, agent team, or human._

## Verification gate

- _What must be true to call this phase done._
```

## 6. Migration

One-time work, done as part of the implementation:

1. Rewrite the existing dogfood session `.synergy/sessions/2026-05-22-readme-s-tier/` into the new structure:
   - Move phase content from `02-implementation.mdx` into `phases/01-capture-screenshot/`, `phases/02-rewrite-readme/`, `phases/03-link-validate/`.
   - Each phase folder gets a short `orchestrator.md` (these phases are 15–45 min single-author work, so phase orchestrators are short).
   - Trim `02-implementation.mdx` to just the timeline + agent allocation + phase index.
   - Update CrossRefs to the new slug form.
2. Delete `packages/cli/src/spec.ts`, remove its registration in `packages/cli/src/cli.ts`, and drop CLI tests covering `synergy spec`.
3. Rewrite `synergy:create-spec` skill body around the new contract; copy templates into `templates/`.
4. Update `synergy:spec-authoring` skill body to include the phase add/remove/rename procedures.
5. Update `CLAUDE.md` and `README.md`.
6. Run `synergy validate` to confirm zero errors after the dogfood rewrite.

## 7. Risks

- **Renumbering bugs.** Inserting/removing phases requires renaming folders. If the skill's renumber logic has off-by-one bugs, sessions break. Mitigation: validator errors loudly on gaps/duplicates so bugs surface on the next validate run.
- **CrossRef migration ambiguity.** Some existing CrossRefs may reference phases via the legacy form (`02-implementation#phase-2`). They keep working, but mixed forms in one session is confusing. Mitigation: validator warning on legacy form points users to the new form.
- **Skill drift.** Templates and layout rules now live in skill body files. If the validator and skill diverge, agents could create invalid sessions that validate. Mitigation: integration test that scaffolds a session via the skill's documented procedure, then validates it.
- **Markdown rendering surprises.** Switching the orchestrator panel from `<pre>` to rendered markdown may make some intentionally-monospace orchestrators look wrong. Mitigation: fallback to `<pre>` on parse failure; spot-check the dogfood orchestrator after migration.
- **Sidebar overflow.** A session with 10+ phases makes the sidebar tall. Mitigation: phases section is independently scrollable when overflowing.

## 8. Open questions

Small ones, addressable during implementation without blocking the plan:

- Toast position (top-right vs bottom-center). Default top-right; trivial to flip if it lands badly.
- Sidebar width: 240px proposed; may tune to 260–280 once we see real content.
- Whether the session dropdown should also surface session type (`feature` / `refactor` / `project`) as a small label. Likely yes, but cosmetic.

## 9. Implementation order (preview, not a plan)

The implementation plan will be written as a separate document by the `writing-plans` skill. As a sanity check, a reasonable phase split is:

- **Phase 1:** Spec-kit + validator updates (CrossRef new form, phase folder validation, Summary/Goals required). Self-contained, unblocks everything else.
- **Phase 2:** Preview app restructure — routes, sidebar, page header, copy buttons, drawer. Pure UI work.
- **Phase 3:** Skill-first authoring — delete `synergy spec`, write templates, rewrite skill bodies.
- **Phase 4:** Dogfood migration — rewrite `2026-05-22-readme-s-tier` into the new structure; update README + CLAUDE.md.

The writing-plans skill will turn this into a real plan with verification gates.
