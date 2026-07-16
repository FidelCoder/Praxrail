# Praxrail

Praxrail is an autonomous engineering control plane that turns authenticated
product intent into durable tasks and, in later phases, tested and independently
reviewed pull requests.

This initial foundation includes:

- strict task contracts and lifecycle policy;
- PostgreSQL persistence, jobs, leases, locks, events, and idempotency;
- authenticated Telegram intake and approval commands;
- GitHub App authentication and signed webhook intake;
- structured logs, metrics, traces, and cost accounting; and
- fail-closed configuration with external integrations disabled by default.

## Local Development

Requirements: Node.js 22.12+, pnpm 10+, and Docker with Compose.

```bash
cp .env.example .env
pnpm install --frozen-lockfile
docker compose up -d postgres
pnpm db:migrate
pnpm dev
```

The service listens on `http://localhost:3000`. Liveness is available at
`/health/live`, readiness at `/health/ready`, Telegram at
`/webhooks/telegram/:secret`, GitHub at `/webhooks/github`, and Prometheus
metrics at `/metrics`.

Run the full local verification suite with:

```bash
pnpm verify
```

Local PostgreSQL uses separate `praxrail_migrator` and restricted
`praxrail_app` roles. `pnpm db:migrate` selects `MIGRATION_DATABASE_URL`; the
running service only receives `DATABASE_URL`. Lifecycle shortcuts are
`pnpm stack:start`, `pnpm stack:start:app`, `pnpm stack:logs`, and
`pnpm stack:stop`. The guarded `pnpm db:reset:test` command only accepts a local
`TEST_DATABASE_URL` whose database name ends in `_test`.

## Security

Do not enable Telegram or GitHub until their credentials, allowlists, and webhook
secrets are configured. See [external integrations](docs/runbooks/external-integrations.md)
and the [threat model](docs/security/threat-model.md).

## Architecture

See [architecture](docs/architecture.md), [launch decisions](docs/decisions/0001-initial-launch-defaults.md),
the [role permission matrix](docs/security/role-permissions.md), and the
[foundation implementation status](docs/implementation-status.md).

Deployable observability definitions live in
[`ops/prometheus/alerts.yml`](ops/prometheus/alerts.yml) and
[`ops/grafana/praxrail-dashboard.json`](ops/grafana/praxrail-dashboard.json).
