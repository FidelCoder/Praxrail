#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"
: "${BACKUP_DIRECTORY:?BACKUP_DIRECTORY is required}"
: "${AGE_RECIPIENT:?AGE_RECIPIENT is required}"

for command in pg_dump age sha256sum; do
  command -v "$command" >/dev/null ||
    {
      echo "Missing required command: $command" >&2
      exit 1
    }
done

umask 077
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$BACKUP_DIRECTORY"
temporary="$BACKUP_DIRECTORY/.praxrail-$timestamp.dump.age.tmp"
backup="$BACKUP_DIRECTORY/praxrail-$timestamp.dump.age"
checksum="$backup.sha256"
trap 'rm -f "$temporary"' EXIT

pg_dump "$DATABASE_URL" --format=custom --no-owner --no-acl |
  age --recipient "$AGE_RECIPIENT" --output "$temporary"
test -s "$temporary"
mv "$temporary" "$backup"
sha256sum "$backup" >"$checksum"

if [[ -n "${RCLONE_REMOTE:-}" ]]; then
  command -v rclone >/dev/null ||
    {
      echo "RCLONE_REMOTE is set but rclone is unavailable" >&2
      exit 1
    }
  rclone copyto "$backup" "$RCLONE_REMOTE/$(basename "$backup")"
  rclone copyto "$checksum" "$RCLONE_REMOTE/$(basename "$checksum")"
fi

printf '{"status":"succeeded","backup":"%s","checksum":"%s"}\n' "$backup" "$checksum"
