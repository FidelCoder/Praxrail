# Installation

Praxrail is shipped as three public packages:

- `@praxrail/core` for shared schemas and contracts;
- `@praxrail/client` for typed local or remote runtime access; and
- `@praxrail/cli` for the `praxrail` terminal command.

The source tree currently builds and verifies the packages locally. Registry
publication is gated by the release workflow and npm provenance evidence.

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

Then create a CLI profile:

```bash
praxrail login local --endpoint http://127.0.0.1:3000 --token <bootstrap-token>
praxrail runtime status
praxrail doctor
```

For production use, run the runtime with `DATABASE_URL` scoped to the app role
and `MIGRATION_DATABASE_URL` scoped to the migrator role. Do not place API
tokens, provider tokens, or webhook secrets in repository files.

## Package Verification

Before publishing or installing a release artifact, run:

```bash
pnpm package:verify
```

The package check builds the public packages, regenerates shell artifacts, packs
each tarball, rejects source/tests/secrets/logs, and emits SHA-256 evidence.
