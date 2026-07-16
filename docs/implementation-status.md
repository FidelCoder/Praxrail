# Foundation Implementation Status

The first 15 execution chunks have the following status as of 2026-07-16.

| Chunk   | Status                                                             | Evidence                                                                                                                                           |
| ------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| PXR-001 | Foundation decisions implemented; deployment inputs operator-gated | Accepted ADRs and change procedure; host, backup target, live repository URLs, and owner IDs remain deployment decisions                           |
| PXR-002 | Implemented                                                        | Threat model, role matrix, and technical policy checks                                                                                             |
| PXR-003 | Operator-gated                                                     | Redacted setup/rotation runbook and GitHub App manifest; live account creation, DNS/TLS, and signed provider delivery require operator credentials |
| PXR-010 | Implemented                                                        | Pinned toolchain, CI, Dependabot, secret scan, AGENTS.md, and local verification                                                                   |
| PXR-011 | Implemented                                                        | Typed fail-closed config, secret serialization guards, and redaction tests                                                                         |
| PXR-012 | Implemented                                                        | Compose runtime, restricted app role, migration role, health checks, volume, and lifecycle commands                                                |
| PXR-013 | Implemented                                                        | Versioned relational schema, constraints, indexes, and architecture diagram                                                                        |
| PXR-014 | Implemented                                                        | Explicit transition policy, actor checks, complete READY contract, and concurrency tests                                                           |
| PXR-015 | Implemented                                                        | Transactional events, replay protection, correlation IDs, and claimable outbox service                                                             |
| PXR-016 | Implemented                                                        | PostgreSQL queues, dead letters, renewable leases, and fenced repository locks                                                                     |
| PXR-017 | Implemented                                                        | Structured context, Prometheus metrics/alerts, Grafana dashboard, cost ledger, health probes, and redaction                                        |
| PXR-020 | Implemented                                                        | Authenticated allowlisted Telegram intake, limits, persistence, and durable planning enqueue                                                       |
| PXR-021 | Implemented                                                        | Versioned contract, deterministic policy planner, clarification blocking, and planner-run ledger                                                   |
| PXR-022 | Implemented                                                        | Deterministic commands and actor-bound expiring single-use approvals                                                                               |
| PXR-030 | Implemented                                                        | GitHub App client, signature-first webhooks, repository allowlist, normalized events, and delivery replay protection                               |

PXR-003 cannot be completed by source code alone. Telegram, GitHub, OpenAI,
DNS, TLS, and sandbox repository resources remain disabled until a human operator
provisions their credentials and records redacted delivery evidence. No placeholder
credential is treated as completion.
