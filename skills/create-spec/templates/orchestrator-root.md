# Orchestrator — {{TITLE}}

> **Read this first** before implementing any of the specs in this session.
> Type: `{{TYPE}}`. Scaffolded: {{TODAY}}.

## Overview

_One paragraph: what is being built, why, and what success looks like._

## Dependency graph

Implementation order — items on the same line can run in parallel.

```
Phase 1 (<slug>)
  └─> Phase 2 (<slug>) ┐
                       ├─> Phase 3 (<slug>)
  └─> Phase ? ─────────┘
```

## Parallel chunks

- **Sequential gate:** _Phase 1 must land first; nothing else may start._
- **Parallelizable:** _Phases / chunks that can run as parallel sub-agents._

## Agent strategy

- **Sub-agents (single-shot, isolated)** for: file-bounded implementation
  where the interface is already specified.
- **Agent team (multi-step, exploratory)** for: cross-cutting concerns,
  debugging, integration testing.
- **Human in the loop** at every phase boundary: present a diff, run
  tests, get approval.

## Verification gates

| Gate | Command / criterion |
|---|---|
| After Phase 1 | _`pnpm build` clean, types resolve._ |
| After Phase 2 | _Feature works end-to-end against a smoke test._ |
| After Phase 3 | _Docs + examples shipped, CI green._ |

## How to invoke

Reference this session in Claude Code with:

```
Implement the plan in @.synergy/sessions/<session-name>/
Start with orchestrator.md, then walk the phase folders in order.
```
