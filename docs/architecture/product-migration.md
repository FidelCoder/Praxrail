# Product Architecture Migration

The current root package remains the compatibility runtime while product
boundaries are introduced incrementally.

## Ownership Map

| Current area                              | Target owner                         | Migration rule                                                          |
| ----------------------------------------- | ------------------------------------ | ----------------------------------------------------------------------- |
| `src/domain`, permissions, shared schemas | `praxrail-core`                      | Move stable transport-independent contracts first; keep re-export shims |
| HTTP and runtime composition              | compatibility runtime                | Expose application services through `/api/v1`; retain webhook routes    |
| Direct operator scripts                   | `praxrail`                           | Replace only after equivalent authorized API command exists             |
| New API consumers                         | `praxrail-client`                    | No direct HTTP or PostgreSQL access outside the client/runtime          |
| Process lifecycle                         | `praxrail` plus runtime process lock | Keep root `dist/index.js` as the compatibility entry                    |
| Repository execution                      | worker protocol                      | Reuse worktrees, runner, agents, verification, review, and publisher    |
| Telegram and email                        | connector modules                    | Route shared actions through application services                       |

## Package Dependency Direction

```text
praxrail-core
      ^
      |
praxrail-client
      ^
      |
praxrail

compatibility runtime -> praxrail-core
connectors -> runtime application services
workers -> praxrail-client + praxrail-core
```

Core and client packages may not import Fastify, PostgreSQL, GitHub, Telegram,
email, process-global configuration, or runtime implementation modules.

## Compatibility Sequence

1. Land core contracts and compatibility re-exports.
2. Land `/api/v1`, durable identities, workers, ownership, and event cursors.
3. Land client and CLI lifecycle over the versioned API.
4. Migrate operator and daily developer workflows command by command.
5. Move connectors behind the same command services.
6. Remove a compatibility path only after contract, migration, and recovery
   tests prove all supported consumers have moved.

Schema migrations remain forward-only. Existing task rows, task events,
repository locks, worktrees, pull requests, and provider delivery IDs remain
authoritative throughout the migration.

## Enforced Boundaries

`pnpm boundaries` parses every package import with the TypeScript compiler. Core
may import only Zod; client may import core, Zod, and Node platform modules; CLI
may import only core, client, and Node platform modules. Relative imports must
remain inside their owning package. `pnpm lint` runs this check in CI, so
PostgreSQL, Fastify, connector, runtime-config, and cross-package internal
imports fail before build.
