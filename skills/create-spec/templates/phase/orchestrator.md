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
- **Human in the loop** at: _phase boundary; review before next phase starts._

## Verification gate

- _What must be true to call this phase done._
- _Concrete command or criterion (tests green, lint clean, etc.)._
