# Phase {{PHASE_NUMBER}} Orchestrator — {{PHASE_TITLE}}

## Within-phase sequencing

_How the tasks inside this phase are ordered. Same-line items run in parallel._

```
Task A
  └─> Task B ┐
             ├─> Task D
  └─> Task C ┘
```

## Parallel chunks

- _Which tasks can run as parallel sub-agents._
- _Which tasks must be sequential._

## Agent strategy

- **Sub-agent** for: _bounded, well-specified tasks._
- **Agent team** for: _cross-cutting or exploratory work._
- **Mixed-effort team** for: _expensive reasoning gated by a cheap producer — name the
  cheap producer and the verifier; the verifier sets the quality floor._
- **Model/effort**: declared per agent in the `<AgentTree>`; this phase references agents
  by name only. Start at opus; downgrade only when bounded + verified downstream.
- **Human in the loop** at: _phase boundary; review before next phase starts._

## Verification gate

- _What must be true to call this phase done._
- _Concrete command or criterion (tests green, lint clean, etc.)._
