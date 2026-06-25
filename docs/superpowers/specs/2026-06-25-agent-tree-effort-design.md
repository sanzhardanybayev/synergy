# Agent Tree + Quality-First Effort/Model Selection — Design

**Date:** 2026-06-25
**Status:** Approved (brainstorming) → ready for implementation plan

## Problem

Synergy specs already carry per-agent fan-out metadata (`<AgentAllocation>` entries
with `model`, `effort`, `count`), and the `execute` skill already reads it. But the
**authoring** side never tells the agent *how* to choose a model/effort, so model
selection is left implicit and execution tends to run everything at the parent's tier
(usually Opus) — wasteful — or, if downgraded carelessly, silently lowers output
quality.

Two things are missing:

1. **A quality-first selection rubric** the authoring skills actively apply, so cheaper
   models are used *only* where they cannot lower quality.
2. **A first-class way to see and adjust the agent structure and its effort** — a tree
   (orchestrator → implementors → subteams) that is the single source of truth for
   effort/model, editable from the preview, with phases referencing agents by name.

The component infrastructure (model/effort enums, schema, rendering, execute plumbing,
runtime overrides) already exists and works — this design is about authoring guidance
and a new editable tree representation, not new execution plumbing.

## Goals

- Quality is an **invariant**, cost is what flexes underneath it. A downgrade can never
  silently lower output quality.
- The agent structure is a **tree** and is the **single source of truth** for
  effort/model. Phases reference agents by name only.
- A user can adjust **effort** (cascading) and **model** (per-node) in the preview UI
  and persist via a **Save** button.

## Non-goals

- No changes to the execution *plumbing* — `execute`/`resume` already spawn per
  `model`/`effort`. They only gain "resolve effort/model from the tree by agent name".
- No new model/effort enum values (`opus|sonnet|haiku`, `low|medium|high|max` stay).
- No multi-select bulk edit. Inheritance + per-node override covers "change for a group".

## Design

### 1. Quality-first authoring rubric

The authoring skills teach one rule:

> **Start at `opus`. Drop a tier only when the task is *provably bounded* AND a
> *verification gate downstream would catch a miss*. When unsure, don't drop.**

Tiers:

| Condition | Model / Effort |
|---|---|
| Default — any judgment, design, ambiguity, or risk | `opus` / `high`–`max` |
| Fully-specified implementation against a clear interface, **verified downstream** | `sonnet` / `medium` |
| Purely mechanical, zero-judgment, fully bounded, **verified downstream** | `haiku` / `low` |
| A verification / review node | never below the tier of the riskiest thing it checks |

Two guarantees make quality the invariant:

- **Downgrade only on provably bounded work** — the burden of proof is on going
  cheaper, not on staying capable.
- **A downgraded agent's output is always verified** — a verification gate (review
  agent or human) at the capable tier sits downstream, so degradation is caught. No
  verification gate ⇒ no downgrade. This is exactly why the **mixed-effort team**
  pattern is safe: cheap producers + an expensive verifier; the quality floor is set by
  the verifier.

Lives in `create-spec/SKILL.md` and both orchestrator templates
(`orchestrator-root.md`, `phase/orchestrator.md`). Authoring **requires** every
executable (non-human) node to resolve to a model + effort.

### 2. New `<AgentTree>` component (canonical for hierarchy + effort/model)

A recursive tree:

- **Root** = the orchestrator.
- **Children** = implementor sub-agents and named teams.
- A team (or implementor) may orchestrate a **subteam** — recursive, arbitrary depth.

Node shape:

```ts
interface AgentTreeNode {
  name: string;
  type: 'orchestrator' | 'sub-agent' | 'agent-team';
  teamName?: string;          // display name for team nodes
  responsibility?: string;
  model?: AgentModel;         // per-node, NO inheritance
  effort?: AgentEffort;       // inherited from nearest ancestor if absent
  count?: number;
  children?: AgentTreeNode[];
}
```

- **Effort inherits**: a node with no explicit `effort` resolves to the nearest
  ancestor's. A per-node value overrides locally.
- **Model does not inherit**: each node's model is its own; editing it changes only that
  node.
- Renders as an **interactive** React tree with controls — **not** a static Mermaid
  chart, because nodes are editable.

### 3. `<AgentAllocation>` shrinks to phase ownership

Drops `model`/`effort`/`count`. Becomes only **"which named agents touch which
phase(s)"** — `name`, `phases`, `responsibility`, `type` (to still distinguish
human vs agent rows). The tree owns effort/model; allocation owns the agent→phase map.

### 4. Phases reference agents by name only

`<Phase>` lists agent **names**, with no inline effort/model. To learn the effort, read
the tree. One declaration, one place to change.

### 5. Editing + persistence in the preview

- Per-node **effort dropdown** — shows the inherited value with an "override"
  affordance; choosing a value pins it locally.
- Per-node **model dropdown** — local only (no cascade).
- Edits accumulate in the in-browser buffer (same pattern as prose edits and phase
  status dropdowns).
- **Save** writes the updated tree back into the `<AgentTree>` JSX in the **MDX file**
  (the canonical, git-committed plan the execute skill reads). **Discard** reverts the
  buffer. Reuses the existing daemon MDX-write path.

### 6. Execution honors the tree

`execute`/`resume` resolve each phase's agents by name → look up effort (with
inheritance) + model in the tree → spawn accordingly. Run-time directives ("use sonnet
this run") still override transiently **without** mutating the saved tree, consistent
with the existing guardrail.

### 7. Validator additions

Warn when:

- An executable tree node cannot resolve an effort (no own value and no ancestor with
  one) or lacks a model.
- A phase references an agent **name absent from the tree** (dangling, mirroring the
  existing cross-ref checks).

## Affected surfaces

- `packages/spec-kit` — new `AgentTree` component + styles + schema + types;
  `AgentAllocation` slimmed (component, schema, types, tests).
- `packages/validator` — tree-node effort/model resolution warnings; phase→tree name
  resolution.
- `packages/preview` — interactive tree rendering, effort/model dropdowns, buffer +
  Save/Discard, MDX write-back.
- `plugins/claude-code` skills — `create-spec` (rubric + AgentTree authoring),
  `spec-authoring`, `execute`/`resume` (resolve effort/model from tree by name),
  orchestrator templates.
- `examples/` — migrate `refactor-auth` to the tree + slimmed allocation.
- `CLAUDE.md` — document the rubric, tree, and the phases-reference-by-name convention.

## Open questions

None blocking. Save persists to the MDX plan (decided); a sidecar was considered and
rejected because the user is editing the authored plan, not a transient run directive.
