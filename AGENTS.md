# Praxrail Repository Guidance

## Purpose

Praxrail is an engineering control plane. Persistent state and deterministic
policy decide what may happen; model output is always untrusted input.

## Commands

- Install: `pnpm install --frozen-lockfile`
- Develop: `pnpm dev`
- Verify: `pnpm verify`
- Migrate: `pnpm db:migrate`
- Start PostgreSQL: `docker compose up -d postgres`

## Engineering Rules

- Use strict TypeScript and validate every external payload at the boundary.
- Keep domain policy independent from HTTP, Telegram, GitHub, and model clients.
- Persist state transitions and their audit event in one database transaction.
- Require idempotency keys for external messages and side effects.
- Never put credentials, raw authorization headers, or private message contents
  in logs, errors, fixtures, snapshots, prompts, or pull requests.
- Do not execute repository-controlled commands in the control-plane process.
- Do not weaken sender authentication, webhook verification, repository
  allowlists, budgets, retry limits, or approval expiry to make tests pass.
- Add positive and negative tests for state, authentication, permissions, and
  replay behavior.

## Review Guidelines

Prioritize authorization bypasses, replay bugs, invalid task transitions,
duplicate side effects, secret exposure, concurrency failures, incomplete input
validation, and missing failure-path tests.

## Definition Of Done

`pnpm verify` passes, migrations are forward-safe, relevant operational docs are
updated, and no unresolved high-severity review finding remains.
