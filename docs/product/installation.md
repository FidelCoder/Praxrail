# Installation

Praxrail is shipped as three public packages:

- `praxrail-core` for shared schemas and contracts;
- `praxrail-client` for typed local or remote runtime access; and
- `praxrail` for the `praxrail` and `pxr` terminal commands.

Each published package includes its own npm README with install, usage, and boundary guidance.

Install the terminal package with Node.js 22.12+ available on your PATH:

```bash
npm install -g praxrail
pxr --version
```

Start the local engine from a directory containing your Praxrail `.env`, or from a shell where the same variables are exported:

```bash
pxr start --model <model> --base-url https://share-ai.ckbdev.com
pxr status
pxr ask "Build the requested change" --project <project-id> --repository <repository-id>
pxr stop
```

`pxr start` creates and selects a local Unix-socket profile automatically. When model access is enabled, the current security policy requires distinct `CODEX_BUILDER_API_KEY` and `CODEX_REVIEWER_API_KEY` values. Set `CODEX_BASE_URL`/`OPENAI_BASE_URL`, or pass `--base-url`, when using an OpenAI-compatible proxy. Use `--api-key-env` and `--review-api-key-env` when your shell stores keys under custom names.

## From Source

```bash
pnpm install --frozen-lockfile
pnpm build:packages
pnpm artifacts:cli
pnpm cli -- version
```

Start the local runtime during development:

```bash
docker compose up -d postgres
pnpm db:migrate
pnpm dev
```

Then exercise the CLI:

```bash
pnpm cli -- start --model <model>
pnpm cli -- status
pnpm cli -- doctor
pnpm cli -- stop
```

For current self-hosted compatibility use, run the runtime with `DATABASE_URL` scoped to the app role
and `MIGRATION_DATABASE_URL` scoped to the migrator role. Do not place API
tokens, provider tokens, or webhook secrets in repository files. Hosted mode targets MongoDB/Atlas and server-side secret storage so normal users do not manage an online `.env` file.

## Package Verification

Before publishing or installing a release artifact, run:

```bash
pnpm package:verify
```

The package check builds the public packages, regenerates shell artifacts, packs
each tarball, rejects source/tests/secrets/logs, and emits SHA-256 evidence.
