# Communications

Email and Telegram share one channel-neutral identity, notification, preference,
and remote-action contract. They are useful for monitoring and short decisions;
they are not development shells.

## Identity Lifecycle

```bash
praxrail channel link EMAIL --destination dev@example.com
praxrail channel verify <identity-id> --code <one-time-code>
praxrail channel preference EMAIL --minimum-severity WARNING --mode IMMEDIATE
praxrail channel status
praxrail channel disable <identity-id>
praxrail channel revoke <identity-id> --yes
```

Verification codes are delivered through the configured connector and are not
returned by the API response.

## Connectors

```bash
praxrail channel setup EMAIL --credential-ref secret://praxrail/email
praxrail channel setup TELEGRAM --credential-ref secret://praxrail/telegram
praxrail channel test EMAIL
praxrail channel rotate TELEGRAM --credential-ref secret://praxrail/telegram-v2 --yes
praxrail channel setup EMAIL --disable
```

Connector state is per channel. A failed email circuit does not block Telegram,
and a muted or revoked identity does not change task state.

## Remote Actions

Both transports normalize inbound messages into the same action contract:

- create a task;
- request status;
- answer a clarification;
- pause or resume a task;
- approve or reject an expiring action.

Every state-changing remote action requires a verified identity. Sensitive
actions also require a task-bound, action-bound, single-use grant token.
Replayed, expired, ambiguous, or unauthorized messages fail closed.

## Message Safety

Outbound messages are bounded summaries with terminal hints. They exclude full
logs, raw prompts, secrets, unrestricted diffs, and repository credentials.
Notification rendering strips control characters, escapes HTML, and redacts
credential-shaped URLs before provider delivery.
