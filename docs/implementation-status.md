# Implementation Status

The execution chunks have the following status as of 2026-07-17. `Implemented`
means the source, migration, and local deterministic evidence exist. It does not
substitute for external sandbox evidence or owner signoff.

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

| Chunk   | Status                                           | Evidence or remaining gate                                                                                            |
| ------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| PXR-031 | Implemented; target onboarding operator-gated    | Strict repository policy, inspection report, instruction digest, and separate owner approval                          |
| PXR-032 | Implemented                                      | Fenced per-repository worktrees, canonical remotes, managed roots, cleanup, and lifecycle tests                       |
| PXR-033 | Implemented                                      | Argument-array runner, explicit environment, pinned network-off containers, time/output/disk limits                   |
| PXR-040 | Implemented locally; live Codex gated            | Official SDK provider, durable agent runs, structured results, bounded actions, cancellation, and fake adapter        |
| PXR-041 | Implemented                                      | Durable command-by-command verification, mutation detection, required gates, and evidence digest                      |
| PXR-042 | Implemented                                      | Separate builder/reviewer keys and providers, read-only review, exact diff digest, file/line validation               |
| PXR-043 | Implemented                                      | Failure taxonomy, attempt/review limits, budget blocking, actionable repair context, no-progress detection            |
| PXR-050 | Implemented; sandbox GitHub gated                | Exact reviewed-diff commit, task-only branch, secret/path scan, idempotent PR create/update                           |
| PXR-051 | Implemented                                      | Manual-only release merge decision; calibrated auto-merge remains disabled                                            |
| PXR-052 | Implemented; live Telegram gated                 | Durable notification outbox, delivery ledger, retry isolation, sanitization, stable IDs                               |
| PXR-053 | Implemented                                      | UTC ledger query, owner-timezone scheduling, DST tests, stored idempotent report and delivery state                   |
| PXR-060 | Implemented; sandbox reconciliation gated        | Startup/scheduled reconciliation, manual merge/close/check/head decisions, audited idempotent actions                 |
| PXR-061 | Implemented                                      | Safe terminal cleanup, disk guard, dead-letter retention, attributable lock/outbox recovery CLI                       |
| PXR-062 | Local controls pass; release scan operator-gated | Secret/path scanning, fuzz tests, containment tests, security assessment ledger; live image/dependency review remains |
| PXR-063 | Implemented                                      | Deterministic Telegram/GitHub/Codex/deployment fakes and mapped failure scenario catalog                              |
| PXR-070 | Operator-gated                                   | Must pass all 14 scenarios twice in clean sandbox environments and collect owner signoff                              |
| PXR-071 | Operator-gated                                   | Pinned production Compose/systemd definitions exist; VPS, TLS, webhooks, reboot, and health evidence do not           |
| PXR-072 | Procedures implemented; drill operator-gated     | Encrypted backup/restore scripts and runbooks exist; off-host backup and clean restore drill remain                   |
| PXR-073 | Operator-gated                                   | Pilot protocol exists; agreed sample, task evidence, metrics, and recommendation remain                               |

## Existing Extended Capabilities

| Chunk   | Status                              | Evidence or gate                                                                                              |
| ------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| PXR-100 | Implemented locally; provider gated | Authenticated sender policy, SPF/DKIM/DMARC alignment, task/thread correlation, scanned attachment metadata   |
| PXR-110 | Implemented                         | Ledger-derived weekly facts and explicitly advisory continue/defer/stop/investigate recommendations           |
| PXR-120 | Policy implemented; disabled        | Sample size, rollback rate, eligible class, checks, owner approval, and kill switch are mandatory             |
| PXR-130 | Adapter framework implemented       | Staging deployment ledger, deterministic health gate, conclusive-failure rollback; repository adapter remains |
| PXR-140 | Gate implemented; disabled          | Expiring production approval, production identity, change window, health evidence, incident and rollback      |
| PXR-150 | Implemented                         | Versioned project policy packs, repository identities, worker pool, portfolio/task budgets, owner activation  |

PXR-003 and PXR-070 through PXR-073 cannot be completed by source code alone.
Telegram, GitHub, OpenAI, DNS/TLS, target-repository onboarding, sandbox
acceptance, VPS/reboot, off-host restore, and pilot resources remain disabled
until a human operator records redacted evidence. No placeholder credential,
generated runbook, fake adapter, or local test is treated as that evidence.

## Terminal Product Foundation

| Chunk   | Status                                  | Deterministic evidence                                                                                                                                |
| ------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| PXR-200 | Implemented                             | Product contract, surface ownership, deployment/support matrix, and ADR 0004                                                                          |
| PXR-201 | Implemented                             | Current-to-target ownership map, dependency direction, compatibility sequence, and forward-only migration policy                                      |
| PXR-202 | Implemented                             | Versioned command grammar, flags, output, exit codes, confirmation policy, and transcripts                                                            |
| PXR-203 | Implemented                             | OpenAPI v1 contract, shared Zod schemas, Unix/HTTPS transports, scoped identity, rotation/revocation, cursors, limits, and compatibility policy       |
| PXR-204 | Implemented                             | Fenced ownership state machine, lease rules, invalid transitions, crash recovery, and returned-workspace safety contract                              |
| PXR-205 | Implemented                             | Channel-neutral identity, action, routing, replay, expiry, preference, and redaction contract                                                         |
| PXR-210 | Implemented                             | Core/client/CLI workspace packages, public exports, compatibility runtime, package builds/tests, and compiler-backed boundary check                   |
| PXR-211 | Implemented                             | Authenticated `/api/v1`, project/role scope, normalized errors, idempotent mutations, audit actors, limits, Unix socket, and remote listener          |
| PXR-212 | Implemented                             | Typed local/remote transport, profiles, mode-0600 token fallback, bounded retries, token rotation/revocation, events, output, fake transport tests    |
| PXR-213 | Implemented                             | Injectable CLI foundation, global flags, human/quiet/JSON output, stable exit codes, timeout validation, help/version behavior, and command tests     |
| PXR-214 | Implemented                             | Serve/start/stop/restart/status/logs, PID lock, protected socket, readiness wait, graceful shutdown, stale-lock recovery, systemd/launchd definitions |
| PXR-220 | Implemented                             | Identity-bound embedded/remote workers, repository/profile routing, heartbeats, drain/revocation, task/attempt/repository fences, and mismatch tests  |
| PXR-221 | Implemented                             | Durable attach/pause/human/return/resume/recover service, process cancellation state, managed paths, diff digest, symlink/submodule/secret checks     |
| PXR-222 | Implemented                             | Ordered durable event and separately redacted output cursors, bounded pages/chunks, truncation markers, cancellation-aware watches, resume tests      |
| PXR-223 | Implemented                             | Dependency-gated claims, independent repository locks, restart/lease reconciliation, recovery-required state, and attributable operator recovery      |
| PXR-230 | Implemented                             | Setup, doctor, project, repository, inspection, approval-before-write, JSON/human output, and CLI help/completions                                    |
| PXR-231 | Implemented                             | Task create/list/status/control, clarify, prioritize, pause/resume, cancel, retry, abandon, archive, approval decision, and recovery commands         |
| PXR-232 | Implemented                             | Event pages, watch, output logs, evidence, cost, cursor, follow, bounded output, and task/repository/project filters                                  |
| PXR-233 | Implemented                             | Attach, local shell, explicit return, managed workspace context, fencing token, lease, and recovery flow                                              |
| PXR-234 | Implemented                             | Diff, verification, findings, review/fix/publish requests, pull-request evidence, and precondition checks                                             |
| PXR-240 | Implemented                             | Channel-neutral identities, preferences, quiet hours, render/redaction, delivery ledger, circuit state, and connector status                          |
| PXR-241 | Provider-gated                          | Telegram connector is wired through shared delivery and normalized remote-action contracts; live bot sandbox evidence remains external                |
| PXR-242 | Provider-gated                          | Email provider gateway, identity verification delivery, connector setup/test/disable, and fake delivery tests exist; live provider evidence remains   |
| PXR-243 | Implemented                             | Remote action grants, replay prevention, preference routing, per-channel reliability state, and tests for transport parity                            |
| PXR-250 | Registry-gated                          | Public package metadata, generated completions/manpage, package verification script, tarball content checks, and release workflow dry runs            |
| PXR-251 | Implemented                             | Upgrade preflight, versioned API/client/runtime contract, forward-only migration requirement, and support docs                                        |
| PXR-252 | Implemented locally                     | Threat-model addendum, shell containment, redaction, package content checks, and deterministic security tests; external scans remain release-gated    |
| PXR-253 | Implemented                             | Doctor, support bundle, connector state, outbox pressure, worker/schema checks, and redacted operational docs                                         |
| PXR-254 | Implemented docs; live onboarding gated | Installation, quickstart, terminal, communication, and upgrade docs exist; live channel onboarding remains external evidence                          |
| PXR-255 | Release-gated                           | Local typecheck/focused tests/product DB scenario recorded in 0.3.0 gate doc; npm, live providers, scans, and two clean release runs remain           |

Verification evidence is produced by `pnpm verify`, the PostgreSQL integration
suite against a freshly migrated `praxrail_test`, the package-level acceptance
commands, container build, installed CLI smoke test, and runtime image smoke
test. External GitHub, Telegram, email, Codex, TLS, and pilot gates remain
tracked separately and are not claimed by these chunks.
