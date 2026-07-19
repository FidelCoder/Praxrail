# ADR 0002: Durable State And Outbox

- Status: accepted
- Date: 2026-07-16

Task projections and append-only task events are written in one PostgreSQL
transaction. Incoming provider event IDs are unique. External side effects are
represented by durable outbox records before delivery.

This makes process restarts and provider retries ordinary cases instead of
special recovery paths. It also prevents model context or worker memory from
becoming authoritative state.

## Supersession Note

ADR 0005 proposes MongoDB/Atlas as the hosted product datastore. The durable-state invariant remains: projections, event ledger entries, outbox writes, idempotency records, and leases must change atomically across the correct transaction boundary. PostgreSQL remains the 0.3.x compatibility datastore until that migration is implemented.
