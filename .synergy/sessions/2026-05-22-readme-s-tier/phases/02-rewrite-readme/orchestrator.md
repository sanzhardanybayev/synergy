# Phase 2 Orchestrator — Rewrite README.md

## Within-phase sequencing

One author walks the blueprint top to bottom. Section 1 → 8 in order, since later sections (Reference, Troubleshooting) reference shapes set up earlier.

## Parallel chunks

None. The README is a single file; concurrent edits would only create merge friction.

## Agent strategy

Human author. README copy is judgment-heavy — tone, what to cut, what reads cold — and benefits from a single voice.

## Verification gate

`wc -l README.md` ≤ 250. All eight blueprint sections present. Reference content sits in tables, not prose. No verbatim copy from AGENTS.md / CLAUDE.md — link to them instead.
