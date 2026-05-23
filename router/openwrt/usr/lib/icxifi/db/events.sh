#!/bin/sh

ICXIFI_DB="${ICXIFI_DB:-/etc/icxifi/icxifi.db}"
ICXIFI_SCHEMA="${ICXIFI_SCHEMA:-/usr/lib/icxifi/db/schema.sql}"

icxifi_db_available() {
  command -v sqlite3 >/dev/null 2>&1
}

icxifi_db_ready() {
  icxifi_db_available || return 1
  [ -s "$ICXIFI_DB" ] || {
    [ -s "$ICXIFI_SCHEMA" ] || return 1
    mkdir -p "$(dirname "$ICXIFI_DB")"
    sqlite3 "$ICXIFI_DB" < "$ICXIFI_SCHEMA" >/dev/null 2>&1 || return 1
  }
  return 0
}

icxifi_sql_escape() {
  printf '%s' "${1:-}" | sed "s/'/''/g"
}

icxifi_json_escape() {
  printf '%s' "${1:-}" | sed 's/\\/\\\\/g; s/"/\\"/g; s/\r//g; s/\n/\\n/g'
}

icxifi_is_uint() {
  case "$1" in ''|*[!0-9]*) return 1 ;; *) return 0 ;; esac
}

icxifi_now_epoch() {
  date +%s 2>/dev/null || printf '0'
}

icxifi_record_sale() {
  source="$1"
  amount="$2"
  device_id="$3"
  voucher_code="$4"
  client_mac="$5"
  client_ip="$6"
  synced="${7:-0}"

  icxifi_db_ready || return 0
  icxifi_is_uint "$amount" || amount=0
  case "$synced" in 1) synced=1 ;; *) synced=0 ;; esac

  source_sql="$(icxifi_sql_escape "$source")"
  device_sql="$(icxifi_sql_escape "$device_id")"
  voucher_sql="$(icxifi_sql_escape "$voucher_code")"
  mac_sql="$(icxifi_sql_escape "$client_mac")"
  ip_sql="$(icxifi_sql_escape "$client_ip")"

  sqlite3 "$ICXIFI_DB" "INSERT INTO sales_events(source, amount, device_id, voucher_code, client_mac, client_ip, timestamp, synced)
    VALUES('$source_sql', $amount, '$device_sql', '$voucher_sql', '$mac_sql', '$ip_sql', unixepoch(), $synced);" >/dev/null 2>&1 || return 0

  # Flat-file pending sync remains active until the sync worker is fully migrated.
  # Avoid queueing the same sale in sync_queue here, or the cloud can receive duplicates.
}

icxifi_record_session() {
  mac="$1"
  ip="$2"
  minutes="$3"
  down="$4"
  up="$5"
  voucher_code="$6"
  source="$7"

  icxifi_db_ready || return 0
  icxifi_is_uint "$minutes" || minutes=0
  icxifi_is_uint "$down" || down=0
  icxifi_is_uint "$up" || up=0

  mac_sql="$(icxifi_sql_escape "$mac")"
  ip_sql="$(icxifi_sql_escape "$ip")"
  voucher_sql="$(icxifi_sql_escape "$voucher_code")"
  source_sql="$(icxifi_sql_escape "$source")"
  speed_sql="$(icxifi_sql_escape "$(printf '{"downloadKbps":%s,"uploadKbps":%s}' "$down" "$up")")"
  remaining=$((minutes * 60))

  sqlite3 "$ICXIFI_DB" "UPDATE sessions SET status='expired', remaining_seconds=0, updated_at=unixepoch()
    WHERE status='active' AND ((mac != '' AND mac='$mac_sql') OR (ip != '' AND ip='$ip_sql'));" >/dev/null 2>&1 || true
  sqlite3 "$ICXIFI_DB" "INSERT INTO sessions(mac, ip, start_time, end_time, remaining_seconds, status, speed_profile, voucher_code, source, created_at, updated_at)
    VALUES('$mac_sql', '$ip_sql', unixepoch(), unixepoch() + $remaining, $remaining, 'active', '$speed_sql', '$voucher_sql', '$source_sql', unixepoch(), unixepoch());" >/dev/null 2>&1 || true
}

icxifi_mark_voucher_used() {
  code="$1"
  used_by="$2"

  icxifi_db_ready || return 0
  code_sql="$(icxifi_sql_escape "$code")"
  used_by_sql="$(icxifi_sql_escape "$used_by")"
  sqlite3 "$ICXIFI_DB" "UPDATE vouchers SET used=1, used_by='$used_by_sql', used_at=unixepoch(), synced=0 WHERE code='$code_sql';" >/dev/null 2>&1 || true
}
