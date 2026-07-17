# ADR 0004: Terminal-First Product Runtime

- Status: accepted
- Date: 2026-07-17

## Context

Praxrail already has durable task, repository, agent, verification, review, and
publishing foundations. Its original bot-first service boundary does not provide
the installable terminal workflow required by active developers.

## Decision

- The `praxrail` CLI is the complete operational interface.
- Email and Telegram are asynchronous notification and bounded-action channels.
- A versioned runtime API is the only application boundary used by CLI clients,
  workers, and connectors. Clients never query PostgreSQL directly.
- Local clients use a mode-0600 Unix socket. Remote clients use authenticated
  TLS. Both transports expose the same API schemas and authorization.
- The compatibility runtime remains deployable while core contracts, the typed
  client, CLI, worker protocol, and connectors move into explicit packages.
- Human development uses a fenced workspace handoff. Agent and human writers
  cannot own the same worktree concurrently.
- The first supported matrix is Node.js 22 on Linux servers and workers; the CLI
  supports Linux, macOS, and WSL2. Bash and zsh are supported interactive
  shells. GitHub is the supported Git provider.

## Consequences

Praxrail can run locally or on a self-hosted remote runtime and can attach
embedded or remote workers. New transports must use the typed client or the
same application services. Native Windows workers, additional Git providers,
and a graphical dashboard require separate support decisions.
