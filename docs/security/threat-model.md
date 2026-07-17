# Threat Model

## Protected Assets

- task intent, approvals, and audit history;
- repository contents, branches, and pull requests;
- GitHub App, Telegram, database, model, and deployment credentials;
- cost budgets and agent execution limits; and
- owner identity and private message content.

## Trust Boundaries

Telegram, GitHub, repository files, issue text, pull request comments,
attachments, and model output are untrusted. The HTTP boundary authenticates and
validates providers. The domain layer enforces authority. PostgreSQL stores
durable facts. Repository commands receive an explicit minimal environment and
never inherit control-plane secrets. Builder and reviewer use distinct required
credentials; the reviewer is read-only and neither role has merge authority.

## Threats And Controls

| Threat                        | Prevention                                                      | Detection                            | Response                              |
| ----------------------------- | --------------------------------------------------------------- | ------------------------------------ | ------------------------------------- |
| Telegram sender spoofing      | Numeric user/chat allowlists and webhook secret                 | Rejected-auth metric and audit event | Rotate secret; disable integration    |
| GitHub webhook forgery/replay | HMAC verification and unique delivery ID                        | Signature/replay counters            | Rotate webhook secret; reconcile      |
| Approval replay/forwarding    | Actor-bound, task-bound, expiring, single-use token digest      | Rejected approval event              | Revoke pending approvals              |
| Prompt injection              | Policy outside prompts; schema validation; no model authority   | Planner validation failures          | Block task and review input           |
| Command injection             | Argument arrays, fixed working roots, environment allowlist     | Runner policy event                  | Cancel attempt; quarantine repository |
| Secret exfiltration           | Process separation, redaction, no secrets in model/repo process | Secret scan and egress audit         | Rotate credentials immediately        |
| Cross-repository write        | Repository allowlist, installation binding, per-repo locks      | Repository identity mismatch         | Disable repository and investigate    |
| Duplicate side effect         | Idempotency keys, outbox, provider external IDs                 | Conflict and replay metrics          | Reconcile provider state              |
| Stale worker write            | Renewable lease with fencing token                              | Lease-loss event                     | Terminate stale process; reconcile    |
| Unlimited cost/retry          | Transactional budgets and bounded attempts                      | Budget threshold alerts              | Pause queue; request approval         |
| Database compromise           | Restricted roles, TLS, encrypted backups, audit trail           | Database and audit alerts            | Isolate, rotate, restore, investigate |

## Security Invariants

1. Model output never grants authority or changes policy directly.
2. Repository-controlled code never receives control-plane credentials.
3. The reviewer and planner have no repository push credentials.
4. Failed authentication and failed policy evaluation have no side effects.
5. External delivery is at-least-once internally and effectively-once through
   idempotency.
6. Integrations fail closed when required security configuration is absent.
7. Host command execution is disabled outside explicit test mode; verification
   requires a digest-pinned, network-off container.

## Terminal Product Addendum

| Threat                                   | Control                                                                                                     | Failure state                                                |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Stolen API token                         | Digest-only storage, mode-0600 profile fallback, TLS or mode-0600 Unix socket, rotation and revocation      | Authentication fails after revocation                        |
| Cross-project API read                   | Actor project scope on task, event, output, workspace, and repository operations                            | `ACTION_NOT_PERMITTED` without mutation                      |
| Mutation replay                          | Per-identity operation scope, request digest, idempotency lease, and cached response                        | Conflict on changed body; completed response on exact replay |
| Worker identity takeover                 | Identity-bound worker name, permanent revocation, active lease, repository allowlist, profile match         | Assignment refused or `RECOVERY_REQUIRED`                    |
| Concurrent human/agent writes            | Ownership state machine, monotonic fences, repository lock, cancellation acknowledgement                    | Stale owner receives `CONFLICT`                              |
| Unsafe human return                      | Managed-path checks, tracked/untracked scan, symlink/submodule rejection, secret/path scan, evidence bound  | Workspace remains `HUMAN_OWNED`                              |
| Output exfiltration or memory exhaustion | Redaction before persistence, 32 KiB chunks, truncation marker, 500-record pages, 2 MiB client response cap | Bounded redacted output only                                 |
| API resource exhaustion                  | 1 MiB requests, 30-second server timeout, 600 requests per identity per minute                              | Retryable `RATE_LIMITED` response                            |
| Email or Telegram takeover               | Verified identity digest, revocation state, remote grant token, provider-specific circuit                   | Remote action rejected or connector circuit opens            |
| Package supply-chain drift               | Packed-file allowlist, source/test/secret exclusion, SHA-256 evidence, npm provenance dry run               | Release gate blocks publishing                               |
| Support bundle data leak                 | Redacted manifest-only diagnostics, no raw env, no prompts, no provider bodies, no repository contents      | Bundle generation excludes sensitive material                |

The product API is disabled unless explicitly enabled with a bootstrap token.
Local and remote transports use identical authentication, authorization,
idempotency, audit attribution, error, and cursor behavior.
