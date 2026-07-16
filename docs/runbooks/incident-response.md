# Incident Response And Credential Rotation

## First Response

1. Name an incident commander and evidence recorder.
2. Disable the affected integration or worker without deleting its ledger.
3. Preserve logs, delivery IDs, task events, image/commit digests, and timestamps.
4. Search for secret exposure using digests or identifiers, never raw values.
5. Rotate in the order below, then prove the old credential is rejected.

## Rotation Order

1. Database application and migration credentials if database access is
   suspected.
2. GitHub App private key and webhook secret; suspend the installation while
   rotating.
3. Telegram bot token and webhook secret.
4. Codex builder key and reviewer key independently.
5. Deployment, backup, DNS, and TLS credentials.

After each rotation restart only the affected service, check readiness, send an
authenticated sandbox event, confirm an invalid old credential fails, and scan
logs for accidental disclosure. Do not rotate all identities at once unless
containment requires it; independent rotation preserves diagnostic clarity.

## Prompt Injection

Quarantine the task and repository. Capture only redacted malicious content.
Verify that no command, network, policy, scope, approval, push, or secret access
occurred. Add the exact pattern to the deterministic fixture suite and rerun the
security assessment before unblocking the repository.

## Closure

Closure requires root cause, affected resources, timeline, rotations, evidence
of old-key rejection, reconciliation result, restoration result if applicable,
and concrete follow-up tasks. Critical or high findings block release.
