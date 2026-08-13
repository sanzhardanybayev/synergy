---
name: create-spec
description: Use when the user wants to plan a new feature, refactor, or project. Generates a Synergy MDX spec session in .synergy/sessions/, auto-starts the preview server, and opens the browser. Triggers on phrases like "create a spec for X", "let's plan Y", "scaffold a refactor for Z", "/synergy-spec".
---

<!-- synergy-version: 0.20.0 -->

## Step 0 — Freshness check (run before anything else)

This skill loads at session start, so it can be **stale** if the plugin was updated
mid-session. Before doing any work, confirm you are the newest installed version.
Set `MINE` to the version in the `synergy-version` marker just above, then run:

```bash
MINE="0.20.0"  # ← the synergy-version marker above
CACHE="${CLAUDE_PLUGINS_DIR:-$HOME/.claude/plugins}/cache/synergy/synergy"
NEWEST="$(ls "$CACHE" 2>/dev/null | sort -V | tail -1)"
if [ -n "$NEWEST" ] && [ "$NEWEST" != "$MINE" ] && \
   [ "$(printf '%s\n%s\n' "$MINE" "$NEWEST" | sort -V | tail -1)" = "$NEWEST" ]; then
  printf '⚠ synergy: this session loaded v%s, but v%s is installed. Restart Claude Code to load the latest skills/templates.\n' "$MINE" "$NEWEST"
fi
```

If it prints a warning, **surface that line to the user verbatim** before continuing.
Then proceed — staleness is a warning, not a block.

# create-spec

You are scaffolding a new Synergy MDX spec session. There is **no `synergy spec` CLI command** — this skill is the authoring path. You read templates from disk, fill in placeholders, and write the result into `.synergy/sessions/<name>/`.

## Scope reasoning

Before scaffolding anything, decide the shape of the spec from the user's request. Phase count is a judgment call, not a default.

| Signal | Shape |
|---|---|
| One-paragraph ask, no architecture concerns, < 1 day of work | **Tiny** — `00-overview.mdx` (minimal) + `orchestrator.md`. Nothing else. |
| Single coherent change, clear path, 1–3 days, no parallelism | **Single-phase** — overview (full) + architecture + implementation + one `phases/01-<slug>/`. |
| Multiple independent or sequenced chunks, > 3 days, parallelizable work, multiple agents | **Multi-phase** — overview (full) + architecture + implementation + `phases/01-…/`, `phases/02-…/`, etc. |

When in doubt, ask one clarifying question rather than over-scaffolding.

## Layout rules

Session directory: `.synergy/sessions/<YYYY-MM-DD>-<slug>/`.

**Slug rules** (for both session and phase slugs):
- lowercase, kebab-case (`a-z0-9-`), max 40 chars,
- derived from the title,
- on collision with an existing directory, append `-<6-char-hash>` (sha1 of `title-now`, sliced to 6).

**Required vs optional files:**

| File | Required? |
|---|---|
| `orchestrator.md` | always |
| `00-overview.mdx` | always (Summary + Goals headings required by the validator) |
| `01-architecture.mdx` | optional |
| `02-implementation.mdx` | optional — include when there are phases |
| `_components/` | optional |
| `assets/` | optional |
| `phases/<NN>-<slug>/spec.mdx` | required if the phase folder exists |
| `phases/<NN>-<slug>/orchestrator.md` | optional but warned-on-miss |

**Phase folder format:** `<NN>-<slug>` where `NN` is zero-padded (`01`, `02`, …). `NN` sequence must be gap-free starting at `01`. The slug is the stable identifier; renumbering is safe because CrossRefs use slugs.

**CrossRefs to phases use the slug, not the number:** `<CrossRef to="phases/core" />` resolves to whichever folder has slug `core`, regardless of its numeric prefix. Use `phases/<slug>`, never `phases/02-core` or `02-implementation#phase-2`.

## Templates

Templates live at `$CLAUDE_PLUGIN_ROOT/skills/create-spec/templates/`. Read them with the `Read` tool, substitute placeholders, write into the session. Do **not** paste template bodies back into the conversation.

| Scope | Templates to copy |
|---|---|
| Tiny | `overview-minimal.mdx` → `00-overview.mdx`; `orchestrator-root.md` → `orchestrator.md`. |
| Single-phase | `overview-full.mdx` → `00-overview.mdx`; `architecture.mdx` → `01-architecture.mdx`; `implementation.mdx` → `02-implementation.mdx`; `orchestrator-root.md` → `orchestrator.md`; `phase/spec.mdx` → `phases/01-<slug>/spec.mdx`; `phase/orchestrator.md` → `phases/01-<slug>/orchestrator.md`. |
| Multi-phase | Same as single-phase, but copy the `phase/*` templates once per phase into `phases/<NN>-<slug>/`. |

**Placeholders to substitute** at write time:

| Placeholder | Value |
|---|---|
| `{{TITLE}}` | Session title (human-readable). |
| `{{TYPE}}` | `feature`, `refactor`, or `project`. |
| `{{TODAY}}` | ISO date (`YYYY-MM-DD`). |
| `{{PHASE_NUMBER}}` | Phase ordinal (`1`, `2`, …) — no zero-padding inside templates. |
| `{{PHASE_TITLE}}` | Phase title (human-readable). |

CrossRef placeholders like `<first-phase-slug>`, `<prev-phase-slug>` are hints to **you** — replace them with the real phase slugs the user agreed on. Don't leave angle-bracket placeholders in the written session.

## Scaffolding procedure

1. **Confirm intent.** Restate the user's ask in one sentence. Decide tiny / single-phase / multi-phase per the scope table. Ask one clarifying question only if the shape is ambiguous.
2. **Init if needed.** If `.synergy/` does not exist in the project root, run `node "$CLAUDE_PLUGIN_ROOT/packages/cli/dist/cli.js" init` once. If `.synergy/` already exists, skip this — the scaffold call in step 4 creates the session directory automatically.
3. **Pick the session slug** (`YYYY-MM-DD-<slug>`, max 40 chars in the slug part, `-<6-char-hash>` suffix on collision).
4. **Scaffold the session in one call.** Read each template from `$CLAUDE_PLUGIN_ROOT/skills/create-spec/templates/` with the `Read` tool, substitute all placeholders in-memory, then write the entire session with a single daemon call (prefer the fast path; fall back to per-file writes when the preview is not running):

   ```bash
   # Fast path (daemon running): assign PREVIEW_ORIGIN from `preview status --json`.
   curl -sS -X POST "${PREVIEW_ORIGIN}/api/scaffold" \
     -H 'content-type: application/json' \
     -d '{"session":"<YYYY-MM-DD-slug>",
          "dirs":["_components","assets","phases/01-<slug>"],
          "files":[
            {"path":"orchestrator.md","content":"<filled>"},
            {"path":"00-overview.mdx","content":"<filled>"},
            {"path":"phases/01-<slug>/spec.mdx","content":"<filled>"}
          ]}'

   # Fallback (preview not yet running — use init + per-file writes as before):
   node "$CLAUDE_PLUGIN_ROOT/packages/cli/dist/cli.js" init   # only if .synergy/ absent
   # then Write each file individually
   ```

   Template **reading** is always local (the `Read` tool against `$CLAUDE_PLUGIN_ROOT/skills/create-spec/templates/`). Replace `<…-slug>` hint placeholders with the real slugs before sending.

5. **Start the preview** by running `node "$CLAUDE_PLUGIN_ROOT/packages/cli/dist/cli.js" preview start`. It is idempotent — safe to call when already running.
6. **Print the URL** for the user. Run `preview status --json`, read its non-null `origin`, and resolve `/s/<session-name>/overview` against it. The complete runtime-discovered URL is the contract. Browser auto-open is best-effort and OS-dependent — try it but don't fail the flow on it.
7. **Fill the templates.** Open the written files and replace the placeholder body text (`_..._` blocks, example phases, sample components) with content derived from the conversation.
8. **Validate.** Prefer the daemon endpoint; fall back to the CLI when the preview is not running:

   ```bash
   # Fast path (daemon running):
   curl -sS "${PREVIEW_ORIGIN}/api/validate?session=<session-name>"

   # Fallback:
   node "$CLAUDE_PLUGIN_ROOT/packages/cli/dist/cli.js" validate <session-name>
   ```

   Parse the JSON `issues` array from the daemon response: any item with `severity: "error"` must be fixed. Fix every error before declaring done.

## Component cheat sheet

All from `@synergy/spec-kit`. Keep this short — the canonical list is in the package itself.

| Component | Use for |
|---|---|
| `<Status value="…" />` | Lifecycle badge (draft/proposed/in-progress/blocked/done/shipped). |
| `<Phase number title status estimate>` | Phase summary card inside `02-implementation.mdx`. Phase content itself lives in `phases/<NN>-<slug>/spec.mdx`. |
| `<Timeline milestones={[…]} />` | Ordered milestones with optional `when` / `status`. |
| `<SubSpec slug title summary />` | Pointer to a sibling MDX file from `00-overview.mdx`. |
| `<CrossRef to="…" />` | Validator-enforced spec-to-spec link. Use `phases/<slug>` for phases. |
| `<AgentAllocation entries={[…]} />` | Maps agents to phases by name (no model/effort here — those live in `<AgentTree>`). |
| `<AgentTree nodes={[…]} />` | Agent hierarchy with model/effort per node. Source of truth for fan-out. |
| `<OpenQuestion id question />` | Unresolved decision. |
| `<Risk id title severity />` | Known hazard + mitigation. |
| `<Mockup src alt caption />` | Image from `assets/`. |
| `<Chart kind="flow\|sequence\|state\|er\|gantt\|mindmap">{`mermaid src`}</Chart>` | Diagrams. Default to Mermaid; build a session-local component if Mermaid is insufficient. |

### Agent structure: `<AgentTree>` + `<AgentAllocation>`

Author the agent roster as a tree — the single source of truth for the hierarchy
and for each agent's model/effort:

```mdx
<AgentTree
  context="Orchestrator coordinates; implementors and teams hang beneath it."
  nodes={[
    { name: 'orchestrator', type: 'orchestrator', model: 'opus', effort: 'high', subAgents: [
      { name: 'storage-impl', type: 'sub-agent', responsibility: 'Implement TokenStore', model: 'sonnet', effort: 'medium' },
      { name: 'migration', type: 'agent-team', teamName: 'Migration', model: 'opus', effort: 'max', subAgents: [
        { name: 'scout', type: 'sub-agent', model: 'haiku', effort: 'low' },
        { name: 'verifier', type: 'sub-agent', model: 'opus' },
      ] },
    ] },
  ]}
/>
```

Then map agents to phases with the slimmed `<AgentAllocation>` (name + phases only —
NO model/effort here; those live in the tree). `<Phase>` references agents by name.

**Quality-first model/effort rubric — quality is the invariant, cost flexes underneath:**

> Start at `opus`. Drop a tier only when the task is *provably bounded* AND a
> *verification gate downstream would catch a miss*. When unsure, don't drop.

| Condition | Model / Effort |
|---|---|
| Any judgment, design, ambiguity, or risk (the default) | `opus` / `high`–`max` |
| Fully-specified implementation against a clear interface, **verified downstream** | `sonnet` / `medium` |
| Purely mechanical, zero-judgment, fully bounded, **verified downstream** | `haiku` / `low` |
| A verification / review node | never below the tier of the riskiest thing it checks |

Effort **inherits** down the tree (omit it to inherit the parent's); model is **per-node**
(does not inherit). Every executable node must resolve to a model + effort or the
validator warns.

## Hard rules

- **Prefer components over markdown** for structured content (status, phases, risks, allocations, timelines, charts).
- **No raw markdown links between specs** (`[link](other.mdx)`). Use `<CrossRef>` so the validator can catch breakage.
- **`<Phase>` in `02-implementation.mdx` is a summary card only.** The real phase content lives in `phases/<NN>-<slug>/spec.mdx`. The card's job is to summarize and cross-ref the phase folder.
- **CrossRef phase references use the slug**, not the numeric prefix. `phases/core`, never `phases/02-core` or `02-implementation#phase-2`. Slugs are stable across renumbering; numbers are not.
- **Orchestrator stays plain markdown.** No MDX components, no JSX.

## Stop conditions

Done when **all** of these are true:

- The session directory exists under `.synergy/sessions/<YYYY-MM-DD-slug>/`.
- All `{{PLACEHOLDER}}` substitutions are complete and all `<…-slug>` hints are replaced with real slugs.
- `curl -sS "${PREVIEW_ORIGIN}/api/validate?session=<session-name>"` (or the CLI fallback) returns zero errors, where `PREVIEW_ORIGIN` came from `preview status --json`.
- `orchestrator.md` describes the actual execution strategy (dependency graph, parallel chunks, agent strategy, verification gates) — not template boilerplate.
- The user confirms the session reflects their intent.
