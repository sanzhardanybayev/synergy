# Storage phase — orchestrator

## Sequencing

`TokenStore` interface → `ComplianceStore` impl → dual-write wiring → logging.

## Parallel chunks

- `storage-impl`: TokenStore + ComplianceStore.
- `service-wiring`: dual-write + instrumentation (starts once the interface is frozen).

## Agent strategy

Two bounded sub-agents (`storage-impl`, `service-wiring`), opus/high. No
human-in-the-loop mid-phase.

## Verification gate

Writes land in both stores for 100% of new sessions; p95 write latency benchmarked
before exit.
