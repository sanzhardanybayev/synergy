# Orchestrator — Make the README s-tier

> **Read this first** before implementing the spec in this session.
> Session: `2026-05-22-readme-s-tier`. Type: `refactor`.

## Overview

Rewrite `README.md` against the eight-section blueprint in `01-architecture.mdx`. No new product surface — just packaging what already exists so the README earns the install. Single-author work, single afternoon, hard 250-line cap on the final file.

## Dependency graph

```
Phase 1 (capture screenshot)
   └─> Phase 2 (rewrite README using blueprint + screenshot)
        └─> Phase 3 (cross-link + validate)
```

Strictly sequential. The screenshot has to exist before the README references it; the README has to exist before we link-check it.

## Parallel chunks

None. Each phase is small enough (15–45 min) that splitting into sub-agents adds more overhead than it saves. One author top to bottom.

## Agent strategy

- **Human author** for all three phases. The work is judgment-heavy (what reads well, what to cut) and the output is short — sub-agents would add noise.
- **Human reviewer** at the end of Phase 3. Have a second person read the README cold as if they'd never seen Synergy. Flag anything unclear in the first 30 seconds.
- **No sub-agents** for this session.

## Verification gates

| Phase end | Criteria |
|---|---|
| Phase 1 | `docs/screenshot.png` exists, < 200KB, renders the preview UI with at least one chart visible. |
| Phase 2 | `wc -l README.md` ≤ 250. All eight blueprint sections present. No content lifted verbatim from `AGENTS.md` / `CLAUDE.md` (link instead). |
| Phase 3 | Every Markdown link resolves. `synergy validate` returns zero errors (this spec session must keep validating). PR opened with before/after screenshot. |

## How to invoke

Open Claude Code in `/home/excelsior/projects/synergy/` and say:

```
Implement the plan in @.synergy/sessions/2026-05-22-readme-s-tier/
Start with orchestrator.md, then walk the specs in order.
Single author, no sub-agents.
Stop after each phase for me to glance at the output.
```

The implementing agent should read this file first, then `00-overview.mdx` for the why, then `01-architecture.mdx` for the section blueprint, then `02-implementation.mdx` for the phase-by-phase plan.
