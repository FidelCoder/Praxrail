# Terminal Workflows

The terminal is the complete operational interface for active developers.
`pxr start` opens an interactive prompt in a real terminal after the engine boots; `pxr chat`, `pxr interactive`, and `pxr repl` attach to the same prompt later. Plain text in the prompt creates coding tasks. Prompt commands such as `pxr status`, `pxr tasks`, `/use <project-id> <repository-id>`, and `pxr stop` control the session; `pxr stop` stops the engine and returns to the normal shell.

Scripts should prefer `--json`, `--non-interactive`, stable exit codes, and explicit `--yes` for high-risk commands.

## Projects And Repositories

- `project create|list|show|update|archive` controls project scope.
- `repo add|inspect|approve|list|show|disable|remove` controls repository
  eligibility.
- Approval requires inspection evidence; removal is refused when task history
  exists.

## Tasks

- `task create|list|show|status` creates and reads durable task records.
- `task clarify|prioritize|pause|resume|cancel|retry|abandon|archive` changes
  lifecycle state with an idempotent API mutation.
- `task attempts|costs|verification|findings|diff|pull-request` reads
  evidence without mutating work.
- `task check|review|fix|publish` queues pipeline actions after the required
  evidence gate.

## Observation

- `task events` returns a bounded event page.
- `task watch --follow` resumes from an event cursor.
- `task logs --follow` streams redacted bounded output chunks.
- `doctor`, `upgrade preflight`, and `support bundle` expose operational
  state without secrets.

## Human Handoff

- `task attach` requests human ownership and pauses the agent.
- `task shell` opens a local shell only for the actor that owns the managed
  worktree lease.
- `task return` validates the managed path, fencing token, and reason before
  the agent resumes.
- `task recover --direction HUMAN|AGENT` handles stale ownership when a
  process crashes or a lease boundary is ambiguous.

## Approval Decisions

`approval approve|reject <approval-id> --token <one-time-token> --reason <why>
--yes` records actor-bound decisions through the same approval service used by
remote channels. Tokens are never printed by the CLI.
