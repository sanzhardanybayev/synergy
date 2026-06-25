# Cutover phase — orchestrator

## Sequencing

Feature flag → backfill → read canary (1% → 10% → 100%) → stop dual-write.

## Parallel chunks

Backfill and canary supervision run together under the `migration-team`.

## Agent strategy

`migration-team` (agent team, opus/max) with human-in-the-loop approval at every
canary step.

## Verification gate

Zero store divergence during canary; backfill drops to zero new rows; reads stable at
100% for 24h.
