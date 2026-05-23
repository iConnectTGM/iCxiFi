#!/bin/sh

ICXIFI_DB="${ICXIFI_DB:-/etc/icxifi/icxifi.db}"
ICXIFI_SCHEMA="${ICXIFI_SCHEMA:-/usr/lib/icxifi/db/schema.sql}"
POOL_FILE="${POOL_FILE:-/etc/icxifi/voucher_pool.txt}"

[ -r /usr/lib/icxifi/db/events.sh ] && . /usr/lib/icxifi/db/events.sh

icxifi_voucher_db_ready() {
  command -v sqlite3 >/dev/null 2>&1 || return 1
  icxifi_db_ready 2>/dev/null
}

icxifi_voucher_epoch() {
  raw="$1"
  [ -n "$raw" ] || return 1
  case "$raw" in
    *[!0-9]*)
      date -d "$raw" +%s 2>/dev/null || return 1
      ;;
    *)
      printf '%s' "$raw"
      ;;
  esac
}

icxifi_voucher_add() {
  voucher_code="$1"
  voucher_minutes="$2"
  voucher_amount="$3"
  voucher_expires_at="$4"

  icxifi_voucher_db_ready || return 1
  icxifi_is_uint "$voucher_minutes" || voucher_minutes=0
  icxifi_is_uint "$voucher_amount" || voucher_amount=0
  [ "$voucher_minutes" -gt 0 ] || return 1

  code_sql="$(icxifi_sql_escape "$voucher_code")"
  exp_sql="NULL"
  exp_epoch="$(icxifi_voucher_epoch "$voucher_expires_at" 2>/dev/null || true)"
  if icxifi_is_uint "$exp_epoch"; then
    exp_sql="$exp_epoch"
  fi

  sqlite3 "$ICXIFI_DB" "INSERT INTO vouchers(code, minutes, amount, used, created_at, expires_at, synced)
    VALUES('$code_sql', $voucher_minutes, $voucher_amount, 0, unixepoch(), $exp_sql, 0)
    ON CONFLICT(code) DO UPDATE SET
      minutes=excluded.minutes,
      amount=excluded.amount,
      expires_at=excluded.expires_at,
      synced=0
    WHERE vouchers.used=0;" >/dev/null 2>&1
}

icxifi_voucher_import_pool() {
  pool="${1:-$POOL_FILE}"
  [ -s "$pool" ] || return 0
  icxifi_voucher_db_ready || return 1

  while IFS='|' read -r pool_code pool_minutes pool_amount pool_expires_at pool_rest; do
    [ -n "$pool_code" ] || continue
    icxifi_voucher_add "$pool_code" "${pool_minutes:-0}" "${pool_amount:-0}" "${pool_expires_at:-}" || true
  done < "$pool"
}

icxifi_voucher_find_available() {
  find_code="$1"

  icxifi_voucher_db_ready || return 1
  icxifi_voucher_import_pool "$POOL_FILE" >/dev/null 2>&1 || true
  code_sql="$(icxifi_sql_escape "$find_code")"
  sqlite3 -separator '|' "$ICXIFI_DB" "SELECT code, minutes, amount, COALESCE(expires_at, 0)
    FROM vouchers
    WHERE code='$code_sql'
      AND used=0
      AND (expires_at IS NULL OR expires_at=0 OR expires_at > unixepoch())
    LIMIT 1;" 2>/dev/null
}

icxifi_voucher_mark_used() {
  used_code="$1"
  used_by="$2"

  icxifi_voucher_db_ready || return 1
  code_sql="$(icxifi_sql_escape "$used_code")"
  used_by_sql="$(icxifi_sql_escape "$used_by")"
  sqlite3 "$ICXIFI_DB" "UPDATE vouchers
    SET used=1, used_by='$used_by_sql', used_at=unixepoch(), synced=0
    WHERE code='$code_sql' AND used=0;" >/dev/null 2>&1
}

icxifi_voucher_cleanup_expired() {
  icxifi_voucher_db_ready || return 0
  sqlite3 "$ICXIFI_DB" "DELETE FROM vouchers
    WHERE used=0 AND expires_at IS NOT NULL AND expires_at > 0 AND expires_at < unixepoch() - 86400;" >/dev/null 2>&1 || true
}
