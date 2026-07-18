# Praxrail

Praxrail is an autonomous agentic coding tool for planning, implementing,
testing, reviewing, and publishing software changes across approved
repositories. It turns authenticated change requests into durable task
contracts and independently reviewed pull requests while keeping merge manual.

Praxrail is repository-agnostic. Each project can register one or more
repositories with its own worker profile, isolated execution image,
instructions, verification commands, risk policy, and budget. Requests that do
not identify an unambiguous approved repository are paused for clarification.

The implementation includes:

- strict task contracts and lifecycle policy;
- multi-project, multi-repository onboarding and repository-specific policy;
- PostgreSQL persistence, jobs, leases, locks, events, and idempotency;
- authenticated Telegram intake and approval commands;
- GitHub App authentication and signed webhook intake;
- structured logs, metrics, traces, and cost accounting;
- isolated coding and review agents, deterministic verification,
  reviewed-diff publishing, notifications, reports, and reconciliation;
- encrypted backup/restore and attributable operator recovery tools; and
- fail-closed configuration with merge, production deployment, and external
  integrations disabled by default.

The terminal product is organized as `praxrail-core`, `praxrail-client`, and
`praxrail` workspaces around the compatibility runtime. Active developers
operate Praxrail from the shell; email and Telegram provide notifications,
approvals, clarifications, and concise remote actions.

Start with the [installation guide](docs/product/installation.md),
[quickstart](docs/product/quickstart.md), [terminal workflows](docs/product/terminal-workflows.md),
[communications guide](docs/product/communications.md), and
[upgrade/support guide](docs/product/upgrades-and-support.md). Install the terminal package with `npm install -g praxrail`, then use `pxr start --model <model> --base-url <url>`, `pxr ask "..."`, and `pxr stop` for the shell-first workflow. During source development, run `pnpm cli -- version` to exercise the CLI entry point.

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

Do not enable Telegram, GitHub, or Codex until credentials, allowlists, sandbox
resources, and review evidence are configured. See the
[runbook index](docs/runbooks/README.md), [external integrations](docs/runbooks/external-integrations.md),
[release security review](docs/security/release-review.md), and the
[threat model](docs/security/threat-model.md).

## Architecture

See [architecture](docs/architecture.md), [product scope](docs/decisions/0003-repository-agnostic-agentic-coding.md),
[launch decisions](docs/decisions/0001-initial-launch-defaults.md), the
[role permission matrix](docs/security/role-permissions.md), and the
[implementation status](docs/implementation-status.md).

Deployable observability definitions live in
[`ops/prometheus/alerts.yml`](ops/prometheus/alerts.yml) and
[`ops/grafana/praxrail-dashboard.json`](ops/grafana/praxrail-dashboard.json).
