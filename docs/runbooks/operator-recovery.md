# Operator Recovery

## Triage

Record the operator ID, task ID, repository ID, correlation ID, last event,
lease/lock owner, outbox status, pull request state, and provider delivery ID.
Take no mutation until persisted state and external facts agree on the intended
action.

Useful read-only queries:

`SELECT * FROM repository_locks ORDER BY expires_at;`

`SELECT id, topic, status, attempts, last_error FROM outbox_events WHERE status
IN ('FAILED', 'PROCESSING') ORDER BY updated_at;`

`SELECT task_id, event_type, actor_type, actor_id, occurred_at FROM task_events
WHERE task_id = '<task-id>' ORDER BY id;`

## Expired Repository Lock

Confirm the owning process is absent, the lease is expired, and no worktree
write is in progress. Then run:

`pnpm operator release-lock <repository-uuid> --actor <operator-id> --reason
"expired worker confirmed absent; incident INC-..."`

The command refuses a non-expired lock and writes an `operator_actions` record.
After release, enqueue reconciliation before retrying work.

## Failed Outbox Delivery

Confirm the provider-side effect did not already occur. For Telegram, a
`SENDING` delivery is treated as possibly sent and is not blindly repeated.
For a recoverable `FAILED` or stale `PROCESSING` record:

`pnpm operator retry-outbox <outbox-uuid> --actor <operator-id> --reason
"provider confirms no delivery; incident INC-..."`

Notification retry is independent from task execution.

## Partial Publishing

Compare the reviewed diff digest, local commit, remote task branch, and pull
request head. Never force-push the default branch. If the exact candidate commit
already exists remotely, reconcile it and create/update the PR idempotently. If
the remote head differs, mark the task `CHANGES_REQUESTED` and require a fresh
verification and review snapshot.

## Dead Letters

Retain the job payload digest, attempt count, error class, task events, and
external facts. Retry only transient integration or infrastructure failures.
Policy, budget, no-progress, and exhausted-attempt failures require the
corresponding owner action; they are not generic retries.

## Disk Pressure

Pause new claims before free space crosses the configured threshold. Clean only
terminal worktrees with evidence and no live lock. Never use recursive deletion
against a path that has not passed the managed-root and symlink checks.
