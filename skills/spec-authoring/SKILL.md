---
name: spec-authoring
description: Use whenever editing or extending an existing Synergy spec session in .synergy/sessions/. Enforces spec-kit component usage, cross-reference discipline, and session-local component creation. Triggers when the user asks to "update the spec", "add a section to the design doc", "extend the architecture spec", or any edit to a `.synergy/sessions/**/*.mdx` file.
---

<!-- synergy-version: 0.15.3 -->

## Step 0 — Freshness check (run before anything else)

This skill loads at session start, so it can be **stale** if the plugin was updated
mid-session. Before doing any work, confirm you are the newest installed version.
Set `MINE` to the version in the `synergy-version` marker just above, then run:

```bash
MINE="0.15.3"  # ← the synergy-version marker above
CACHE="${CLAUDE_PLUGINS_DIR:-$HOME/.claude/plugins}/cache/synergy/synergy"
NEWEST="$(ls "$CACHE" 2>/dev/null | sort -V | tail -1)"
if [ -n "$NEWEST" ] && [ "$NEWEST" != "$MINE" ] && \
   [ "$(printf '%s\n%s\n' "$MINE" "$NEWEST" | sort -V | tail -1)" = "$NEWEST" ]; then
  printf '⚠ synergy: this session loaded v%s, but v%s is installed. Restart Claude Code to load the latest skills/templates.\n' "$MINE" "$NEWEST"
fi
```

If it prints a warning, **surface that line to the user verbatim** before continuing.
Then proceed — staleness is a warning, not a block.

# spec-authoring

Rules for editing existing Synergy specs. The `create-spec` skill is for new sessions; this skill is for everything after.

## Where to edit

- All session content lives in `.synergy/sessions/<name>/`. Never write spec files outside this tree.
- Add new top-level sub-specs as `NN-<slug>.mdx` where `NN` keeps numeric ordering. Cross-link with `<SubSpec>`.
- Phases live in their own folders: `phases/<NN>-<slug>/spec.mdx` (+ optional `orchestrator.md`). See "Editing phases" below.
- Put session-local React components in `_components/<Name>.tsx` and import them with a relative path from the MDX file.
- Put images in `assets/` and reference them via `<Mockup src="./assets/foo.png" alt="..." />`.

## Component usage

- Always prefer spec-kit components over raw markdown for structured content (status badges, phases, risks, allocations, timelines, charts).
- If the structure you need doesn't exist in spec-kit, build a session-local component in `_components/` rather than dropping back to ad-hoc markdown.
- Charts default to `<Chart>` (Mermaid). For visuals beyond Mermaid, import a chart library (recharts, visx, etc.) inside a session-local component.
- Agent rosters use `<AgentTree>` (hierarchy + model/effort; effort inherits, model is
  per-node) as the source of truth; `<AgentAllocation>` maps agents to phases by name
  only. Never put model/effort on `<AgentAllocation>` or inline on `<Phase>`.
- **Timeline is phase-driven.** Use `<Timeline />` (no props) in the overview — it
  renders the live phase roster + progress bar from execution state. Do not
  reintroduce a hand-authored `milestones={[…]}` list for the phase timeline; it
  drifts from the right rail. Each `phases/<NN>-<slug>/spec.mdx` must have a
  frontmatter `title` (the timeline step label); the validator warns when it is
  missing.

## Cross-references

- Every link between specs in the same session **must** use `<CrossRef to="<slug>" />` or `<CrossRef to="<slug>#<anchor>" />`.
- Phase references use the slug-based form: `<CrossRef to="phases/<slug>" />`. Slugs are stable across renumbering — numeric prefixes are not. Do not write `phases/02-<slug>` or `02-implementation#phase-2`.
- Heading anchors are GitHub-style: lowercase, spaces → `-`, special chars stripped, deduplicated per file.
- After editing, run `node "$CLAUDE_PLUGIN_ROOT/packages/cli/dist/cli.js" validate <session-name>` — dangling cross-refs are validation errors.

## Editing phases

Phase folders are `phases/<NN>-<slug>/`. `NN` is zero-padded and must be gap-free starting at `01`. The slug is the stable identifier (CrossRefs use it); `NN` only sets display order.

### Add a phase (append to the end)

1. **Pick a slug** from the phase title (lowercase kebab-case, max 40 chars).
2. **Pick `NN`** — `max(existing NN) + 1`, zero-padded.
3. **Create the folder:** `mkdir -p .synergy/sessions/<name>/phases/<NN>-<slug>`.
4. **Copy templates** from `$CLAUDE_PLUGIN_ROOT/skills/create-spec/templates/phase/`:
   - `spec.mdx` → `phases/<NN>-<slug>/spec.mdx`
   - `orchestrator.md` → `phases/<NN>-<slug>/orchestrator.md`

   Substitute `{{PHASE_NUMBER}}` (the ordinal as a plain number, not zero-padded) and `{{PHASE_TITLE}}`.
5. **Update `02-implementation.mdx`:** add a `<Phase>` summary card that cross-refs `phases/<slug>`.
6. **Update `orchestrator.md`** (root) to include the new phase in the dependency graph and verification gates.
7. **Validate:** `node "$CLAUDE_PLUGIN_ROOT/packages/cli/dist/cli.js" validate <session-name>`.

### Insert a phase between existing ones

Pick the slot `N` (1-indexed) where the new phase will sit. Every existing phase with prefix `>= N` shifts up by one.

1. **Rename downstream folders in REVERSE order** to avoid `mv` collisions. If you currently have `01`, `02`, `03` and want to insert at slot `02`:
   ```bash
   mv phases/03-<slug>  phases/04-<slug>
   mv phases/02-<slug>  phases/03-<slug>
   ```
   (Reverse order is mandatory — going forward would overwrite the next folder before it has been moved.)
2. **Create the new phase folder** at slot `<N>-<slug>` and copy the phase templates (as in "Add a phase" steps 3–4).
3. **Update `02-implementation.mdx` `<Phase number={…} />` props** so the displayed ordinals match the new folder positions.
4. **Update CrossRefs.** Slug-based refs (`<CrossRef to="phases/<slug>" />`) need **no update** because slugs are stable. Legacy refs that hard-code the numeric prefix (`phases/02-<slug>` or `02-implementation#phase-2`) **do** need updating — search and migrate them to the slug-based form.
5. **Update the root `orchestrator.md`** dependency graph to include the new phase.
6. **Validate.**

### Remove a phase

1. **Delete the folder:** `rm -rf .synergy/sessions/<name>/phases/<NN>-<slug>`.
2. **Renumber the downstream folders in ASCENDING order** (each `mv` decreases the prefix, so there is no collision risk):
   ```bash
   mv phases/03-<slug>  phases/02-<slug>
   mv phases/04-<slug>  phases/03-<slug>
   ```
3. **Remove the `<Phase>` card** from `02-implementation.mdx`. Re-number the remaining `<Phase number={…} />` props.
4. **Update CrossRefs.** Slug-based refs to the *removed* phase will now dangle — the validator will flag them. Either delete the references or redirect them to a still-existing phase. Slug-based refs to *renumbered* phases need no update (slugs didn't change).
5. **Update the root `orchestrator.md`** to drop the phase from the dependency graph and verification gates.
6. **Validate.**

### Rename a phase

Keep the prefix; change the slug.

1. **Rename the folder:** `mv phases/<NN>-<old-slug> phases/<NN>-<new-slug>`.
2. **Update the `title:` frontmatter** in `phases/<NN>-<new-slug>/spec.mdx`.
3. **Update CrossRefs that reference the old slug:** grep for `phases/<old-slug>` and replace with `phases/<new-slug>`.
4. **Update `02-implementation.mdx`** — the `<Phase>` card's `title` prop and any `<CrossRef to="phases/<old-slug>" />` inside it.
5. **Validate.**

## Iterating with the preview

1. Start the preview with `node "$CLAUDE_PLUGIN_ROOT/packages/cli/dist/cli.js" preview start` if needed, then run `node "$CLAUDE_PLUGIN_ROOT/packages/cli/dist/cli.js" preview status --json`. Use its non-null `origin` to build `/s/<session-name>/overview`; never assume a fixed port.
2. On every save, MDX files hot-reload in the browser. Confirm the user can see your change before moving on.
3. When you add, remove, or rename a phase folder, the virtual session index is rebuilt and the page does a full reload.

## Verification

Before declaring an edit complete:

```
node "$CLAUDE_PLUGIN_ROOT/packages/cli/dist/cli.js" validate <session-name>
```

Zero errors. Warnings are OK (e.g. unparseable non-literal expressions in props) but should be reviewed.

## Don'ts

- Don't add files outside the session directory and claim they're part of the spec.
- Don't write raw markdown links between specs (`[link](01-architecture.mdx)`). Use `<CrossRef>`.
- Don't reference phases by numeric prefix (`phases/02-<slug>`). Use the slug-based form (`phases/<slug>`).
- Don't bypass the validator by silencing errors. If a CrossRef doesn't resolve, fix the target.
- Don't bundle implementation code into the spec — the spec describes the implementation, the agents implement it elsewhere.
- Don't edit `orchestrator.md` to be more MDX-like — it's plain markdown by design.
- Don't leave gaps in phase numbering. If you remove a phase, renumber the rest.
