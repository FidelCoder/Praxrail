# ADR 0005: MongoDB Hosted Control Plane And Vercel Boundary

- Status: proposed
- Date: 2026-07-19

## Context

Praxrail is shifting from a local compatibility runtime toward an installable terminal product with an optional hosted control plane. Users should be able to install the package, authenticate, select a model, start or stop a local engine, and run coding work without copying product secrets into source repositories.

The current 0.3.x runtime persists task projections, events, queues, leases, locks, outbox messages, and audit records in PostgreSQL. That remains the compatibility path until the datastore migration lands.

## Decision

- MongoDB Atlas is the target datastore for hosted Praxrail control-plane state.
- User-facing package installs should not require users to create a local database for normal hosted mode.
- Hosted secrets must live in a server-side secret store, not in published packages, browser bundles, task prompts, or repository `.env` files.
- The terminal library reads local `.env` only for local development or self-hosted runtime mode.
- Hosted mode should use login/profile tokens to reach the Praxrail control plane; the control plane resolves tenant model-provider secrets server-side.
- Vercel is not required for the coding engine, worker loop, repository worktrees, queue consumers, or long-running agent execution.
- Vercel may be used later for a marketing site, documentation site, dashboard, or thin HTTPS API facade if it forwards work to the hosted control plane instead of running agents itself.

## MongoDB Data Model Direction

Collections should preserve the existing invariants:

- `tenants`: account and billing boundary;
- `users`: authenticated human operators;
- `projects`: product-level grouping;
- `repositories`: approved repo policy, installation binding, default branch, worker profile;
- `tasks`: durable task projection and ownership state;
- `task_events`: append-only task event ledger;
- `task_attempts`: agent attempts, provider/model metadata, result summary;
- `outbox`: durable external deliveries with idempotency keys;
- `incoming_messages`: provider delivery dedupe;
- `workers`: leases, capabilities, heartbeat, and assignment state;
- `repository_locks`: fenced repository/worktree locks;
- `approvals`: one-time remote approvals with expiry;
- `secret_refs`: encrypted references to provider keys, never raw secret values;
- `audit_events`: attributable operator and system actions.

Transactions are required anywhere a projection and its event/outbox record must change together. Unique indexes must enforce provider delivery IDs, idempotency keys, approval tokens, repository lock ownership, and active worker leases.

## Consequences

The migration is a real datastore implementation project, not a variable rename. SQL queries, migrations, pg-boss queue usage, integration tests, backups, and runbooks must be replaced with MongoDB repositories, indexes, transactions, queue/lease mechanics, and Atlas backup/restore guidance.

Until that work is complete, documentation must clearly distinguish:

1. current local/self-hosted compatibility mode, which uses `DATABASE_URL`; and
2. target hosted mode, which uses MongoDB/Atlas internally and exposes login/profile-based CLI access to users.
