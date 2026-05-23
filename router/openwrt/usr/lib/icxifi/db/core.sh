#!/bin/sh

ICXIFI_DB="${ICXIFI_DB:-/etc/icxifi/icxifi.db}"
ICXIFI_SCHEMA="${ICXIFI_SCHEMA:-/usr/lib/icxifi/db/schema.sql}"

icxifi_db_available() {
  command -v sqlite3 >/dev/null 2>&1
}

icxifi_db_exec() {
  icxifi_db_available || return 127
  mkdir -p "$(dirname "$ICXIFI_DB")"
  sqlite3 "$ICXIFI_DB" "$@"
}

icxifi_db_init() {
  icxifi_db_available || return 127
  [ -s "$ICXIFI_SCHEMA" ] || return 1
  mkdir -p "$(dirname "$ICXIFI_DB")"
  if [ -s "$ICXIFI_DB" ]; then
    icxifi_db_migrate
  fi
  sqlite3 "$ICXIFI_DB" < "$ICXIFI_SCHEMA"
  icxifi_db_migrate
}

icxifi_sql_escape() {
  printf '%s' "${1:-}" | sed "s/'/''/g"
}

icxifi_db_migrate() {
  icxifi_db_available || return 127
  [ -s "$ICXIFI_DB" ] || return 0
  sqlite3 "$ICXIFI_DB" "ALTER TABLE sales_events ADD COLUMN local_event_id TEXT;" >/dev/null 2>&1 || true
  sqlite3 "$ICXIFI_DB" "ALTER TABLE sync_queue ADD COLUMN next_attempt_at INTEGER NOT NULL DEFAULT 0;" >/dev/null 2>&1 || true
  sqlite3 "$ICXIFI_DB" "CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_events_local_event ON sales_events(local_event_id) WHERE local_event_id IS NOT NULL;" >/dev/null 2>&1 || true
  sqlite3 "$ICXIFI_DB" "CREATE INDEX IF NOT EXISTS idx_sync_queue_status ON sync_queue(status, next_attempt_at, created_at);" >/dev/null 2>&1 || true
}
