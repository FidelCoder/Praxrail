# Deployment And Rollback

## Hosted Product Boundary

The core Praxrail engine is not a Vercel deployment target. The coding engine,
queue workers, repository worktrees, and publish pipeline require persistent
workers, durable locks, and controlled filesystem/process execution. Vercel can
host a documentation site, dashboard, login pages, or a thin HTTP facade, but it
should forward work to a real Praxrail control plane.

Hosted product mode targets MongoDB/Atlas for control-plane persistence and a
server-side secret store for tenant model-provider keys. The current 0.3.x
compatibility runtime still uses PostgreSQL until the MongoDB repositories,
indexes, transaction boundaries, backup/restore, and integration tests are
implemented.

## Preconditions

- PXR-070 has two `PASSED` acceptance records with owner signoff.
- The release commit has no open critical or high security finding.
- The application image is signed, scanned, and referenced by registry digest.
- `PRAXRAIL_IMAGE_DIGEST` contains `registry/name@sha256:...`.
- `PRAXRAIL_SECRETS_DIR` is root-owned, mode `0700`, and contains every file
  referenced by `ops/compose.production.yaml` with mode `0400`.
- Downstream application production deployment credentials are absent.
- A tested prior application digest and a current encrypted backup are recorded.

## Host Provisioning

1. Create a dedicated supported Linux VPS and record provider, region, image,
   disk encryption status, and asset owner.
2. Create separate `praxrail` and `praxrail-backup` service accounts with no
   interactive password. Do not add the application user to unrestricted sudo.
3. Permit inbound SSH from the operator allowlist and HTTPS from providers.
   Keep ports 3000, 5432, and 5433 bound to loopback.
4. Disable password SSH, require named keys, enable automatic security updates,
   time synchronization, and host audit logging.
5. Install Docker Engine, Compose, age, PostgreSQL client tools, rclone, curl,
   gitleaks, and Trivy from trusted repositories.
6. Put the checkout at `/opt/praxrail`. Put environment metadata and secret
   files under `/etc/praxrail`, outside the checkout.

## Deploy

1. Verify the release commit and image signature. Record both digests.
2. Pull the exact image digest, then set `pull_policy: never` during startup so
   the host cannot silently substitute another image.
3. Run migrations once using the migration database identity. The application
   container receives only the restricted `praxrail_app` URL.
4. Validate the merged Compose model:

   `docker compose -f compose.yaml -f ops/compose.production.yaml config`

   Inspect the output for loopback bindings, digest-pinned images, read-only
   application root, dropped capabilities, and secret file mounts. Abort if a
   secret value appears.

5. Install `ops/systemd/praxrail.service` and start it. Require the readiness
   check to pass before changing webhooks.
6. Configure the TLS reverse proxy to forward only the two webhook paths.
   Enforce a 1 MiB body limit, modern TLS, request timeouts, and access-log
   redaction.
7. Deliver authenticated Telegram and GitHub sandbox events. Run one
   documentation-only request through reviewed PR creation.
8. Reboot the VPS. Record boot ID, service status, readiness result, queue
   status, and reconciliation result.

## Drain

Disable new webhook delivery at the provider, leave health endpoints available,
and wait for active repository locks and worker leases to reach zero. Do not
remove a live lock. Stop the service only after the event ledger and provider
delivery IDs are recorded.

## Rollback

1. Disable provider delivery and drain work.
2. Set `PRAXRAIL_IMAGE_DIGEST` to the recorded prior digest.
3. Restart `praxrail.service` without reversing database migrations. Migrations
   are forward-only; if the prior binary is incompatible, deploy a forward
   compatibility patch.
4. Verify readiness, schema checksums, queue ownership, and reconciliation.
5. Re-enable sandbox delivery and record the reason, actor, old/new digests,
   health evidence, and incident ID.

Rollback is not successful until one authenticated event is processed exactly
once and no task is left with a live lease owned by the replaced process.
