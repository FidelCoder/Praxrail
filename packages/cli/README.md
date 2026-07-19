# praxrail

Terminal engine and CLI for Praxrail, an autonomous agentic coding runtime for active developers.

## Install

```bash
npm install -g praxrail
pxr --version
```

Node.js 22.12 or newer is required.

## Start the engine

Run `pxr start` from a directory containing your Praxrail `.env`, or export the same variables in your shell:

```bash
pxr start --model gpt-5.5 --base-url https://share-ai.ckbdev.com
pxr status
pxr doctor
```

Current 0.3.x releases run a local/remote Praxrail runtime and require a durable runtime database. The existing compatibility runtime uses PostgreSQL via `DATABASE_URL`; the product roadmap moves shared hosted control-plane state to MongoDB/Atlas so end users do not need to manage local database credentials.

## Required model settings

```bash
CODEX_BUILDER_API_KEY=builder-key
CODEX_REVIEWER_API_KEY=reviewer-key
CODEX_MODEL=gpt-5.5
CODEX_BASE_URL=https://share-ai.ckbdev.com
```

Builder and reviewer keys must be distinct by policy. Use `--api-key-env` and `--review-api-key-env` if your shell stores keys under different names.

## Daily terminal commands

```bash
pxr ask "Build the requested change" --project <project-id> --repository <repository-id>
pxr tasks
pxr watch <task-id>
pxr output <task-id>
pxr shell <task-id>
pxr stop
```

Email and Telegram are for notifications and bounded remote actions. Active development stays in the terminal.

## Packages

- `praxrail` exposes `praxrail` and `pxr` commands.
- `praxrail-client` provides typed local/remote runtime access.
- `praxrail-core` provides transport-independent schemas and contracts.

Source: https://github.com/FidelCoder/Praxrail
