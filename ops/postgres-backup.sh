#!/usr/bin/env sh
set -eu

COMPOSE_FILE=${COMPOSE_FILE:-docker-compose.prod.yml}
BACKUP_DIR=${BACKUP_DIR:-./backups/postgres}
DATABASE_NAME=${POSTGRES_DATABASE:-ponder}
DATABASE_USER=${POSTGRES_USER:-ponder}

case "$DATABASE_NAME" in
  ''|*[!A-Za-z0-9_]*) echo "POSTGRES_DATABASE must contain only letters, digits, and underscores" >&2; exit 1 ;;
esac
mkdir -p "$BACKUP_DIR"
timestamp=$(date -u +%Y%m%dT%H%M%SZ)
partial="$BACKUP_DIR/$DATABASE_NAME-$timestamp.dump.partial"
output="$BACKUP_DIR/$DATABASE_NAME-$timestamp.dump"
trap 'rm -f "$partial"' EXIT HUP INT TERM

docker compose -f "$COMPOSE_FILE" exec -T ponder-db \
  pg_dump --username "$DATABASE_USER" --format=custom --no-owner --no-acl "$DATABASE_NAME" \
  > "$partial"
test -s "$partial"
mv "$partial" "$output"
sha256sum "$output" > "$output.sha256"
trap - EXIT HUP INT TERM
echo "$output"
