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
  sqlite3 "$ICXIFI_DB" < "$ICXIFI_SCHEMA"
}

icxifi_sql_escape() {
  printf '%s' "${1:-}" | sed "s/'/''/g"
}
