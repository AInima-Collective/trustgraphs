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

direct=${DATABASE_URL:+1}
created_restore=0

compose_db() {
  docker compose -f "$COMPOSE_FILE" exec -T ponder-db "$@"
}
maintenance_query() {
  query=$1
  if [ -n "$direct" ]; then
    psql "$DATABASE_URL" --tuples-only --no-align --command "$query"
  else
    compose_db psql --username "$DATABASE_USER" --dbname postgres \
      --tuples-only --no-align --command "$query"
  fi
}
restore_query() {
  query=$1
  if [ -n "$direct" ]; then
    psql "$RESTORE_DATABASE_URL" --tuples-only --no-align --command "$query"
  else
    compose_db psql --username "$DATABASE_USER" --dbname "$RESTORE_DATABASE" \
      --tuples-only --no-align --command "$query"
  fi
}
create_restore_database() {
  if [ -n "$direct" ]; then
    createdb --maintenance-db "$DATABASE_URL" "$RESTORE_DATABASE"
  else
    compose_db createdb --username "$DATABASE_USER" "$RESTORE_DATABASE"
  fi
}
drop_restore_database() {
  if [ -n "$direct" ]; then
    dropdb --maintenance-db "$DATABASE_URL" "$RESTORE_DATABASE"
  else
    compose_db dropdb --username "$DATABASE_USER" "$RESTORE_DATABASE"
  fi
}
restore_backup() {
  if [ -n "$direct" ]; then
    pg_restore --dbname "$RESTORE_DATABASE_URL" --no-owner --no-acl < "$backup"
  else
    compose_db pg_restore --username "$DATABASE_USER" --dbname "$RESTORE_DATABASE" \
      --no-owner --no-acl < "$backup"
  fi
}
cleanup_restore_database() {
  if [ "$created_restore" = 1 ]; then
    drop_restore_database >/dev/null 2>&1 || true
  fi
}

if [ -n "$direct" ]; then
  test -n "${RESTORE_DATABASE_URL:-}" || {
    echo "RESTORE_DATABASE_URL is required with DATABASE_URL and must name $RESTORE_DATABASE" >&2
    exit 1
  }
  for tool in psql createdb dropdb pg_restore; do
    command -v "$tool" >/dev/null 2>&1 || {
      echo "$tool is required when DATABASE_URL is set" >&2
      exit 1
    }
  done
fi
exists=$(maintenance_query "SELECT 1 FROM pg_database WHERE datname = '$RESTORE_DATABASE'")
if test "$exists" = 1; then
  test "${REPLACE_RESTORE_DATABASE:-0}" = 1 || {
    echo "$RESTORE_DATABASE already exists; choose another drill name or set REPLACE_RESTORE_DATABASE=1" >&2
    exit 1
  }
  drop_restore_database
fi

create_restore_database
created_restore=1
trap cleanup_restore_database EXIT HUP INT TERM
if [ -n "$direct" ]; then
  restored_name=$(restore_query 'SELECT current_database()')
  test "$restored_name" = "$RESTORE_DATABASE" || {
    echo "RESTORE_DATABASE_URL does not name $RESTORE_DATABASE" >&2
    exit 1
  }
fi
restore_backup

tables=$(restore_query "SELECT count(*) FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema')")
test "$tables" -gt 0 || { echo "restore produced no application tables" >&2; exit 1; }
created_restore=0
trap - EXIT HUP INT TERM
echo "restore drill passed: $RESTORE_DATABASE contains $tables application tables"
