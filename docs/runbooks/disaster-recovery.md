# Disaster Recovery

## Objectives

- Recovery point objective: 24 hours for a total host loss; outbox/provider
  reconciliation may recover newer external facts.
- Recovery time objective: 4 hours after replacement infrastructure and secret
  store access are available.
- Backup retention: 14 daily and 8 weekly encrypted copies, including one
  off-host location under a separate identity.

These are targets until a timestamped restore drill demonstrates them.

## Backup

Install `ops/systemd/praxrail-backup.service` and its timer. Configure
`DATABASE_URL` with a read-only backup identity, `BACKUP_DIRECTORY`,
`AGE_RECIPIENT`, and `RCLONE_REMOTE` in `/etc/praxrail/backup.env`. The age
private identity must not exist on the application VPS.

`scripts/backup.sh` creates a custom-format PostgreSQL dump, encrypts before
final placement, writes a SHA-256 checksum, and optionally transfers both
objects off-host. Alert if the timer fails, the newest checksum is older than
26 hours, or off-host object size is zero.

## Restore Drill

1. Provision a clean isolated database with no production network route.
2. Retrieve an encrypted backup and checksum from off-host storage.
3. Set `RESTORE_TARGET_DATABASE_URL`, `AGE_IDENTITY_FILE`, and
   `RESTORE_CONFIRMATION=RESTORE_TO_CLEAN_DATABASE`.
4. Run `scripts/restore.sh <backup.dump.age>`.
5. Run migrations in checksum-validation mode, then the full integration suite.
6. Compare task, task-event, approval, pull-request, cost, and outbox counts to
   the backup manifest. Exercise one reconciliation without provider mutation.
7. Record backup timestamp, restore start/end, lost-data window, checksum,
   record counts, operator, and result in the drill report.
8. Destroy the isolated restored database after evidence review.

## Dependency Loss

| Dependency | Immediate action                           | Recovery validation                           |
| ---------- | ------------------------------------------ | --------------------------------------------- |
| Telegram   | Disable webhook and retain intake ledger   | Authorized fixture accepted once              |
| GitHub     | Stop publish/reconcile mutations           | Installation identity and signed event pass   |
| Codex      | Stop new builder/reviewer calls            | Separate keys work only in assigned worker    |
| PostgreSQL | Stop service; restore to clean host        | Checksums, counts, and event ordering pass    |
| VPS        | Provision replacement from pinned images   | Reboot, readiness, and reconciliation pass    |
| DNS/TLS    | Disable provider delivery; preserve queues | Certificate and external signed delivery pass |

## Backup Key Loss

Treat loss or exposure of the age identity as a security incident. Rotate the
recipient, create a new backup, verify restore with the new key, expire old
copies according to legal retention, and record which historical recovery
points remain usable.
