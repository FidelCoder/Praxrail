# Communication Contract v1

Email and Telegram are equal asynchronous transports over one identity,
notification, and command policy.

## Shared Remote Actions

- create a task;
- answer one correlated clarification;
- approve or reject one expiring action;
- pause or resume a task; and
- request concise status.

Repository onboarding, full logs, diffs, workspace attach, verification control,
publishing, recovery, credentials, and runtime administration are terminal-only.

## Identity

An external address maps to one Praxrail identity, role, project scope, verified
destination, and revocation state. Provider authentication does not grant a role
by itself. Identity links are created and revoked through the CLI.

## Message Safety

- Every inbound message has provider, sender, thread, task, body digest,
  correlation, and replay identifiers.
- Clarifications and approvals bind actor, task, action, policy version,
  expiration, and single use.
- Ambiguous, stale, spoofed, oversized, replayed, or unauthorized messages fail
  closed and are audited.
- Outbound messages contain bounded summaries and terminal command hints. They
  exclude raw prompts, full logs, secrets, and unrestricted diffs.

## Routing

Routing is per user, project, channel, event severity, immediate/digest mode,
quiet hours, and escalation. Each channel has its own retry, rate, circuit, and
dead-letter state. A failure or revocation in one channel cannot block task
state or the other channel.
