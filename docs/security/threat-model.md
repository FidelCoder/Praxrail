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
durable facts. Repository execution and model workers are separate processes in
later phases and never inherit control-plane secrets.

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
