# Release Security Review

Status on 2026-07-16: local controls pass; release remains operator-gated.

| Control                           | Local evidence                                                            | Release evidence required                           |
| --------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------- |
| Webhook authentication and replay | HMAC, allowlist, unique delivery tests                                    | Signed Telegram/GitHub sandbox deliveries           |
| Approval expiry and replay        | Actor-bound token and expiry integration tests                            | Owner approval behavior signoff                     |
| Log and prompt secret isolation   | Redaction, secret serialization, explicit provider/subprocess environment | Runtime log scan with mounted secrets               |
| Filesystem confinement            | Managed-root, symlink, worktree fencing tests                             | Host/container escape exercise                      |
| Command and network confinement   | No shell, pinned read-only-root container, no network, limits             | Pinned worker image execution on target host        |
| Git remote and publish scope      | Canonical identity, task branch, protected/default rejection, exact diff  | Sandbox installation and branch protection evidence |
| Builder/reviewer separation       | Distinct required keys/providers and read-only reviewer                   | Separate service-account audit records              |
| Prompt injection                  | Untrusted blocks, schema checks, no model authority, fuzz fixtures        | Malicious issue/repository/Telegram exercise        |
| Dependencies and images           | Lockfile, Dependabot, gitleaks workflow, local quality gates              | Current high/critical audit and Trivy report        |
| Recovery and backup               | Reconciliation tests, encrypted scripts, restore runbook                  | Clean restore drill and VPS reboot record           |

No critical or high finding is open in the local deterministic suite. That
statement does not cover live provider configuration, current third-party
advisories, target-host hardening, or a restore that has not been performed.
Those missing facts block release rather than becoming accepted residual risk.

Run `scripts/security-check.sh` in the release environment with gitleaks and,
when `PRAXRAIL_IMAGE` is set, Trivy. Store the commit, image digest, tool
versions, timestamps, redacted reports, remediation links, and named approver in
`security_assessments`.
