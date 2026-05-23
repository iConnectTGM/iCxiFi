#!/bin/sh

ICXIFI_DB="${ICXIFI_DB:-/etc/icxifi/icxifi.db}"
ICXIFI_SCHEMA="${ICXIFI_SCHEMA:-/usr/lib/icxifi/db/schema.sql}"

[ -r /usr/lib/icxifi/db/events.sh ] && . /usr/lib/icxifi/db/events.sh

icxifi_session_db_ready() {
  command -v sqlite3 >/dev/null 2>&1 || return 1
  icxifi_db_ready 2>/dev/null
}

icxifi_session_expire_old() {
  icxifi_session_db_ready || return 0
  sqlite3 "$ICXIFI_DB" "UPDATE sessions
    SET status='expired', remaining_seconds=0, updated_at=unixepoch()
    WHERE status='active' AND end_time <= unixepoch();" >/dev/null 2>&1 || true
}

icxifi_session_select() {
  mac="$1"
  ip="$2"
  statuses="$3"

  icxifi_session_expire_old
  mac_sql="$(icxifi_sql_escape "$mac")"
  ip_sql="$(icxifi_sql_escape "$ip")"
  sqlite3 -separator '|' "$ICXIFI_DB" "SELECT id,mac,ip,start_time,end_time,remaining_seconds,status,speed_profile,voucher_code,source
    FROM sessions
    WHERE status IN ($statuses)
      AND ((mac != '' AND mac='$mac_sql') OR (ip != '' AND ip='$ip_sql'))
    ORDER BY updated_at DESC, id DESC
    LIMIT 1;" 2>/dev/null
}

icxifi_session_pause() {
  mac="$1"
  ip="$2"
  remaining="$3"
  down="$4"
  up="$5"

  icxifi_session_db_ready || return 1
  icxifi_is_uint "$remaining" || remaining=0
  icxifi_is_uint "$down" || down=10000
  icxifi_is_uint "$up" || up=10000
  [ "$remaining" -gt 0 ] || return 1

  mac_sql="$(icxifi_sql_escape "$mac")"
  ip_sql="$(icxifi_sql_escape "$ip")"
  speed_sql="$(icxifi_sql_escape "$(printf '{"downloadKbps":%s,"uploadKbps":%s}' "$down" "$up")")"

  sqlite3 "$ICXIFI_DB" "UPDATE sessions
    SET status='paused',
        remaining_seconds=$remaining,
        end_time=unixepoch() + $remaining,
        speed_profile=CASE WHEN speed_profile IS NULL OR speed_profile='' THEN '$speed_sql' ELSE speed_profile END,
        updated_at=unixepoch()
    WHERE id = (
      SELECT id FROM sessions
      WHERE status='active'
        AND ((mac != '' AND mac='$mac_sql') OR (ip != '' AND ip='$ip_sql'))
      ORDER BY updated_at DESC, id DESC
      LIMIT 1
    );" >/dev/null 2>&1 || return 1
}

icxifi_session_resume() {
  mac="$1"
  ip="$2"
  remaining="$3"
  down="$4"
  up="$5"

  icxifi_session_db_ready || return 1
  icxifi_is_uint "$remaining" || remaining=0
  icxifi_is_uint "$down" || down=10000
  icxifi_is_uint "$up" || up=10000
  [ "$remaining" -gt 0 ] || return 1

  mac_sql="$(icxifi_sql_escape "$mac")"
  ip_sql="$(icxifi_sql_escape "$ip")"
  speed_sql="$(icxifi_sql_escape "$(printf '{"downloadKbps":%s,"uploadKbps":%s}' "$down" "$up")")"

  sqlite3 "$ICXIFI_DB" "UPDATE sessions
    SET status='active',
        ip=CASE WHEN '$ip_sql' != '' THEN '$ip_sql' ELSE ip END,
        mac=CASE WHEN '$mac_sql' != '' THEN '$mac_sql' ELSE mac END,
        start_time=unixepoch(),
        end_time=unixepoch() + $remaining,
        remaining_seconds=$remaining,
        speed_profile=CASE WHEN speed_profile IS NULL OR speed_profile='' THEN '$speed_sql' ELSE speed_profile END,
        updated_at=unixepoch()
    WHERE id = (
      SELECT id FROM sessions
      WHERE status='paused'
        AND ((mac != '' AND mac='$mac_sql') OR (ip != '' AND ip='$ip_sql'))
      ORDER BY updated_at DESC, id DESC
      LIMIT 1
    );" >/dev/null 2>&1 || return 1
}

icxifi_session_json_from_row() {
  row="$1"
  connected="$2"
  disconnected="$3"

  IFS='|' read -r sid mac ip start_time end_time remaining status speed voucher source <<EOF_ROW
$row
EOF_ROW
  unset IFS

  now="$(date +%s 2>/dev/null || printf '0')"
  if [ "$status" = "active" ]; then
    remaining=$((end_time - now))
    [ "$remaining" -lt 0 ] && remaining=0
  fi
  icxifi_is_uint "$remaining" || remaining=0
  minutes=$((remaining / 60))
  down="$(printf '%s' "$speed" | sed -n 's/.*"downloadKbps"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' | head -n 1)"
  up="$(printf '%s' "$speed" | sed -n 's/.*"uploadKbps"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' | head -n 1)"
  down="${down:-10000}"
  up="${up:-10000}"

  paused=false
  [ "$status" = "paused" ] && paused=true
  disc_field=""
  [ "$disconnected" = "1" ] && disc_field=',"disconnectedWithTime":true'
  printf '{"ok":true,"connected":%s,"paused":%s%s,"minutesLeft":%s,"remainingSeconds":%s,"downloadKbps":%s,"uploadKbps":%s,"clientIp":"%s","clientMac":"%s","source":"sqlite"}\n' \
    "$connected" "$paused" "$disc_field" "$minutes" "$remaining" "$down" "$up" "$(icxifi_json_escape "$ip")" "$(icxifi_json_escape "$mac")"
}
