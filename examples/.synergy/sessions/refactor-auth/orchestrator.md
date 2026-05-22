# Orchestrator — Refactor auth middleware

> **Read this first** before implementing any of the specs in this session.
> Session: `refactor-auth`. Type: `refactor`.

## Overview

Replace the legacy auth token store with a compliance-approved store. The public middleware API stays the same; the swap is invisible to downstream services. The rollout uses dual-write → canary reads → cleanup to keep the migration safe under load.

Success criteria:
1. Reads are 100% on the compliance store with no p95 latency regression.
2. Zero session-loss incidents during cutover (active sessions migrate, no forced re-login).
3. Compliance audit packet signed off and legacy store decommissioned.

## Dependency graph

```
Phase 1 (storage + dual-write)
   ├─ storage-impl (sub-agent)   ┐
   └─ service-wiring (sub-agent) ┤── parallel within Phase 1
                                 │
                                 ▼
Phase 2 (cutover + migration) ── migration-team (agent team, human-supervised canary)
                                 │
                                 ▼
Phase 3 (cleanup + audit) ─────── audit-prep (sub-agent)
```

## Parallel chunks

- **Phase 1:** `storage-impl` and `service-wiring` run in parallel — they share the frozen `TokenStore` interface but touch disjoint files.
- **Phase 2:** runs as an agent team, not sub-agents. The canary rollout requires multi-step reasoning (read metrics → decide to advance → rollback if needed) that single-shot sub-agents handle poorly.
- **Phase 3:** single sub-agent (`audit-prep`) is sufficient.

## Agent strategy

- **Sub-agents** for: bounded implementation tasks where the interface is already frozen (Phase 1, Phase 3).
- **Agent team** for: cross-cutting work with live-traffic decisions (Phase 2 canary).
- **Human in the loop** at every phase boundary:
  - End of Phase 1: Avery reviews dual-write correctness against a smoke test.
  - During Phase 2: human approves each canary advance (1% → 10% → 50% → 100%).
  - End of Phase 3: Riya signs off compliance audit packet.

## Verification gates

| Phase end | Command / criteria |
|---|---|
| Phase 1 | `pnpm test` clean; 100% of new sessions appear in both stores; structured logs assert at least 1 write per session. |
| Phase 2 (canary) | At each step: p95 latency within 5% of baseline for 30 min; zero divergence between stores; rollback path tested. |
| Phase 2 (complete) | Reads at 100% for 24h; dual-write disabled; legacy store traffic at zero. |
| Phase 3 | Audit packet PR merged; legacy store dropped; Riya's sign-off recorded. |

## How to invoke

Open Claude Code in the project root and say:

```
Implement the plan in @.synergy/sessions/refactor-auth/
Start with orchestrator.md, then walk the specs in order.
Use sub-agents for Phase 1 and 3, an agent team for Phase 2.
Stop at every phase boundary for my approval.
```

The implementing agent should read this file first, then `00-overview.mdx` for context, then `01-architecture.mdx` for the design, then `02-implementation.mdx` for the phased plan with agent allocation.
