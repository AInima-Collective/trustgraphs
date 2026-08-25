#!/usr/bin/env sh
set -eu

test "$#" -eq 1 || { echo "usage: $0 BACKUP.dump" >&2; exit 2; }
COMPOSE_FILE=${COMPOSE_FILE:-docker-compose.prod.yml}
DATABASE_USER=${POSTGRES_USER:-ponder}
RESTORE_DATABASE=${RESTORE_DATABASE:-ponder_restore_drill}
backup=$1

test -s "$backup" || { echo "backup is missing or empty: $backup" >&2; exit 1; }
case "$RESTORE_DATABASE" in
  ponder_restore_*) ;;
  *) echo "RESTORE_DATABASE must begin ponder_restore_ and contain only letters, digits, underscores" >&2; exit 1 ;;
esac
restore_suffix=${RESTORE_DATABASE#ponder_restore_}
case "$restore_suffix" in
  ''|*[!A-Za-z0-9_]*) echo "RESTORE_DATABASE must begin ponder_restore_ and contain only letters, digits, underscores" >&2; exit 1 ;;
esac

exists=$(docker compose -f "$COMPOSE_FILE" exec -T ponder-db \
  psql --username "$DATABASE_USER" --dbname postgres --tuples-only --no-align \
  --command "SELECT 1 FROM pg_database WHERE datname = '$RESTORE_DATABASE'")
if test "$exists" = 1; then
  test "${REPLACE_RESTORE_DATABASE:-0}" = 1 || {
    echo "$RESTORE_DATABASE already exists; choose another drill name or set REPLACE_RESTORE_DATABASE=1" >&2
    exit 1
  }
  docker compose -f "$COMPOSE_FILE" exec -T ponder-db \
    dropdb --username "$DATABASE_USER" "$RESTORE_DATABASE"
fi

docker compose -f "$COMPOSE_FILE" exec -T ponder-db \
  createdb --username "$DATABASE_USER" "$RESTORE_DATABASE"
docker compose -f "$COMPOSE_FILE" exec -T ponder-db \
  pg_restore --username "$DATABASE_USER" --dbname "$RESTORE_DATABASE" --no-owner --no-acl \
  < "$backup"

tables=$(docker compose -f "$COMPOSE_FILE" exec -T ponder-db \
  psql --username "$DATABASE_USER" --dbname "$RESTORE_DATABASE" --tuples-only --no-align \
  --command "SELECT count(*) FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema')")
test "$tables" -gt 0 || { echo "restore produced no application tables" >&2; exit 1; }
echo "restore drill passed: $RESTORE_DATABASE contains $tables application tables"
