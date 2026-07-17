# Upgrades And Support

Praxrail upgrades are forward-only and must preserve durable tasks, leases,
workspaces, outbox state, and audit history.

## Upgrade Preflight

```bash
praxrail upgrade preflight
```

The preflight blocks when human-owned workspaces are active, publishing tasks
are mid-flight, or the database schema is not at the expected product version.
A normal upgrade is:

1. Drain workers.
2. Create and verify a database backup.
3. Install packages using recorded checksums.
4. Run forward-only migrations with the migrator role.
5. Restart the runtime.
6. Run `praxrail doctor` and resume workers.

## Diagnostics

`praxrail doctor` checks database readiness, schema version, worker presence,
outbox pressure, and connector state. `praxrail support bundle` emits a
redacted bundle manifest, runtime checks, resource counts, and recent failure
metadata. It intentionally excludes prompts, secrets, environment dumps,
repository contents, and raw provider payload bodies.

## Compatibility

The 0.3.x CLI, client, runtime API, and worker contract are expected to remain
compatible within the v1 API. A newer runtime may require `upgrade preflight`
before accepting mutating commands from older clients.
