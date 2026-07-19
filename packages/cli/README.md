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
```

In an interactive terminal, `pxr start` starts the engine and then opens the Praxrail prompt. Type normal requests to create tasks, and type `pxr stop` inside the prompt to stop the engine and return to your shell. Use `pxr start --non-interactive` or `pxr start --json` for scripts that should only boot the engine and exit.

```text
pxr> Build the requested change
pxr> /tasks
pxr> pxr stop
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
pxr chat --project <project-id> --repository <repository-id>
pxr ask "Build the requested change" --project <project-id> --repository <repository-id>
pxr tasks
pxr watch <task-id>
pxr output <task-id>
pxr shell <task-id>
pxr stop
```

`pxr chat`, `pxr interactive`, and `pxr repl` attach to the prompt so active developers can type naturally. `pxr ask "..."` remains the single-command form for scripts and quick one-offs.

Email and Telegram are for notifications and bounded remote actions. Active development stays in the terminal.

## Packages

- `praxrail` exposes `praxrail` and `pxr` commands.
- `praxrail-client` provides typed local/remote runtime access.
- `praxrail-core` provides transport-independent schemas and contracts.

Source: https://github.com/FidelCoder/Praxrail
