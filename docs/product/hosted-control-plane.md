# Hosted Control Plane, Secrets, And Vercel

Praxrail should not ask normal hosted users to maintain an online `.env` file. Hosted mode should keep product secrets on the server and give the installed `pxr` CLI a scoped profile token.

## Target Hosted Flow

```bash
npm install -g praxrail
pxr login
pxr start --model gpt-5.5
# Praxrail opens pxr> in an interactive terminal
pxr> Build the requested change
pxr> /tasks
pxr> pxr stop
```

`pxr ask "..."` remains available for scripts and one-off task creation. The CLI stores only a runtime/profile token locally. Provider API keys, Telegram secrets, GitHub credentials, repository policy, billing state, and task state stay in the hosted control plane.

## Recommended Hosting Shape

Npm is the distribution channel for the `pxr` library; it is not where Praxrail runs. The first hosted Praxrail deployment should use:

- a persistent Docker/container runtime for the API, scheduler, queue workers, repository workspaces, and agent loops;
- MongoDB Atlas for hosted control-plane state;
- the host provider secret manager plus Praxrail's own encrypted tenant/project secret records for model-provider keys and integration credentials; and
- optional Vercel deployment only for documentation, marketing, dashboard, login, or a thin HTTP facade.

Preferred first host: Fly.io Machines for the long-running control plane and workers, backed by MongoDB Atlas. Railway, Render, AWS ECS/Fargate, GCP Cloud Run jobs/services, or DigitalOcean Apps can also work if they provide persistent process execution, private networking, secrets, logs, and controlled worker scaling.

## Secret Ownership

| Secret                                | Hosted location                                                  | Local package behavior                              |
| ------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------- |
| Model-provider API key                | Server-side encrypted secret store, referenced by tenant/project | Not bundled; local `.env` only for self-hosted mode |
| GitHub App private key/webhook secret | Hosted control plane secret store                                | Never exposed to CLI packages                       |
| Telegram bot token/webhook secret     | Hosted control plane secret store                                | Never exposed to CLI packages                       |
| Praxrail profile token                | User machine profile store                                       | Revocable and scoped                                |
| MongoDB connection string             | Hosted runtime environment/secret manager                        | Never exposed to users                              |

## MongoDB

MongoDB Atlas is the target database for hosted control-plane state. The local 0.3.x compatibility runtime still uses PostgreSQL while the migration is implemented. Do not rename `DATABASE_URL` to `MONGODB_URI` until MongoDB repositories, indexes, transactions, tests, backups, and runbooks exist.

## Vercel Decision

Vercel is optional, not required, for Praxrail's core engine.

Use Vercel only for:

- documentation or marketing pages;
- a dashboard UI;
- login/account pages; or
- a thin HTTP facade that forwards to the real control plane.

Do not run the Praxrail coding engine, queue workers, repository worktrees, long-running agent loops, or publish pipeline directly on Vercel. Those need a persistent worker/control-plane runtime with durable locks, filesystem isolation, queue leases, and controlled process execution.

## Required Before Hosted Launch

1. MongoDB persistence implementation and index migration scripts.
2. Server-side secret encryption and rotation.
3. `pxr login`, profile refresh, logout, and token revocation.
4. Tenant/project/repository policy APIs.
5. Hosted worker registration and heartbeat.
6. Atlas backup/restore and disaster-recovery runbook.
7. Npm package docs that explain local mode vs hosted mode.
