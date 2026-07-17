# Product Contract

Praxrail is an installable autonomous coding runtime for active software
developers. It operates across approved repositories and software stacks.

## Users

| Role      | Responsibility                                              | Primary surface      |
| --------- | ----------------------------------------------------------- | -------------------- |
| Owner     | Product direction, high-risk approval, repository authority | CLI, email, Telegram |
| Developer | Create, monitor, steer, attach to, and return coding work   | CLI                  |
| Reviewer  | Inspect evidence and independent findings                   | CLI                  |
| Operator  | Runtime, worker, recovery, credentials, and upgrades        | CLI                  |
| Worker    | Execute one fenced assignment using declared capabilities   | Runtime API          |

## Surface Ownership

- CLI: installation, login, runtime lifecycle, repository onboarding, complete
  task control, logs, events, costs, diff, verification, review, publishing,
  human workspace handoff, diagnostics, and recovery.
- Email and Telegram: task intake, status summaries, clarifications, approvals,
  rejections, pause, resume, and delivery alerts.
- Automated runtime: scheduling, worker claims, agent execution, deterministic
  gates, durable state, recovery, and reconciliation.

Email and Telegram never expose full logs, unrestricted diffs, raw prompts,
credentials, repository setup, or an interactive development environment.

## Deployment Modes

- Local: CLI and runtime communicate over a protected Unix socket. An embedded
  worker may execute approved repositories on the same host.
- Remote: CLI connects over TLS to a self-hosted runtime. Workers register using
  scoped identities and may run on separate hosts.
- Compatibility: the existing HTTP/webhook service remains available during
  package migration and uses the same durable database.

## Support Matrix

- Runtime and workers: supported Linux on x64 or arm64.
- CLI: Linux, macOS, and WSL2.
- Interactive shells: bash and zsh. Other shells may use non-interactive JSON.
- Runtime: pinned Node.js 22 and pnpm 10 for source development.
- Git provider: GitHub App with explicitly approved repositories.

## Product Completion

The product is complete only when a clean supported machine can install the CLI,
connect to a local or remote runtime, onboard a sandbox repository, complete and
monitor a task, transfer the workspace safely to a developer and back, publish
the reviewed diff, receive email and Telegram updates, upgrade safely, and
recover from process or worker loss without direct database edits.
