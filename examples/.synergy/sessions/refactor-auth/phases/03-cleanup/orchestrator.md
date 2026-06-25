# Cleanup phase — orchestrator

## Sequencing

Remove dual-write → decommission LegacyStore → assemble audit packet.

## Parallel chunks

Audit-packet prep can run alongside code removal.

## Agent strategy

`audit-prep` sub-agent (sonnet/medium) prepares the packet; Riya signs off.

## Verification gate

Riya's written compliance sign-off; legacy store deleted.
