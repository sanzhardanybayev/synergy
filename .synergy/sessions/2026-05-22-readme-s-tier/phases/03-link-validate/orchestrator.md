# Phase 3 Orchestrator — Cross-link and validate

## Within-phase sequencing

Link check first (cheap, catches typos), then validator, then PR. Each step gates the next.

## Parallel chunks

None worth splitting at this scale.

## Agent strategy

Human author runs the checks. Human reviewer reads the README cold for the 30-second test — this is the only place a second pair of eyes matters in this session.

## Verification gate

`synergy validate` returns zero errors. Every Markdown link resolves. Reviewer signs off on the cold-read.
