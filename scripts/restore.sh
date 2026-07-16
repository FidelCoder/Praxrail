#!/usr/bin/env bash
set -euo pipefail

: "${RESTORE_TARGET_DATABASE_URL:?RESTORE_TARGET_DATABASE_URL is required}"
: "${AGE_IDENTITY_FILE:?AGE_IDENTITY_FILE is required}"
: "${RESTORE_CONFIRMATION:?RESTORE_CONFIRMATION is required}"

if [[ "$RESTORE_CONFIRMATION" != "RESTORE_TO_CLEAN_DATABASE" ]]; then
  echo "RESTORE_CONFIRMATION must equal RESTORE_TO_CLEAN_DATABASE" >&2
  exit 1
fi
if [[ "$#" -ne 1 ]]; then
  echo "Usage: scripts/restore.sh <encrypted-backup.dump.age>" >&2
  exit 1
fi

backup="$1"
checksum="$backup.sha256"
test -r "$backup"
test -r "$checksum"

for command in age pg_restore psql sha256sum; do
  command -v "$command" >/dev/null ||
    {
      echo "Missing required command: $command" >&2
      exit 1
    }
done

sha256sum --check "$checksum"
age --decrypt --identity "$AGE_IDENTITY_FILE" "$backup" |
  pg_restore --dbname="$RESTORE_TARGET_DATABASE_URL" --clean --if-exists --no-owner --no-acl --exit-on-error

psql "$RESTORE_TARGET_DATABASE_URL" --no-psqlrc --set=ON_ERROR_STOP=1 --command="SELECT count(*) AS migrations FROM schema_migrations"
psql "$RESTORE_TARGET_DATABASE_URL" --no-psqlrc --set=ON_ERROR_STOP=1 --command="SELECT count(*) AS task_events FROM task_events"

printf '{"status":"restored","backup":"%s"}\n' "$backup"
