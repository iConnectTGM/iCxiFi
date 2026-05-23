#!/bin/sh
set -eu
export PATH="/usr/sbin:/usr/bin:/sbin:/bin"

WATCHDOG_DIR="${WATCHDOG_DIR:-/usr/lib/icxifi/watchdog}"
CHECK_DIR="$WATCHDOG_DIR/checks"
LOG_DIR="$WATCHDOG_DIR/logs"
STATE_DIR="$WATCHDOG_DIR/state"
LOCK_FILE="/tmp/icxifi-watchdog.lock"
LOG_FILE="$LOG_DIR/watchdog.log"
LOG_MAX_BYTES="${ICXIFI_WATCHDOG_LOG_MAX_BYTES:-262144}"
REBOOT_THRESHOLD_CRITICAL="${ICXIFI_WATCHDOG_REBOOT_THRESHOLD:-5}"
WAN_REBOOT_THRESHOLD="${ICXIFI_WATCHDOG_WAN_REBOOT_THRESHOLD:-10}"

mkdir -p "$CHECK_DIR" "$LOG_DIR" "$STATE_DIR" /etc/icxifi/backup

if ! mkdir "$LOCK_FILE" 2>/dev/null; then
  exit 0
fi
trap 'rmdir "$LOCK_FILE" 2>/dev/null || true' EXIT INT TERM

rotate_log() {
  if [ -f "$LOG_FILE" ]; then
    size="$(wc -c < "$LOG_FILE" 2>/dev/null || echo 0)"
    case "$size" in ''|*[!0-9]*) size=0 ;; esac
    if [ "$size" -gt "$LOG_MAX_BYTES" ]; then
      mv -f "$LOG_FILE" "$LOG_FILE.1" 2>/dev/null || true
      : > "$LOG_FILE"
    fi
  fi
}

log_line() {
  component="$1"
  status="$2"
  message="$3"
  rotate_log
  ts="$(date '+%Y-%m-%d %H:%M:%S' 2>/dev/null || date)"
  printf '%s | %s | %s | %s\n' "$ts" "$component" "$status" "$message" >> "$LOG_FILE"
}

counter_file() {
  component="$1"
  printf '%s/failcount_%s' "$STATE_DIR" "$component"
}

get_counter() {
  file="$(counter_file "$1")"
  [ -s "$file" ] || { printf '0'; return 0; }
  value="$(cat "$file" 2>/dev/null || echo 0)"
  case "$value" in ''|*[!0-9]*) value=0 ;; esac
  printf '%s' "$value"
}

set_counter() {
  printf '%s\n' "$2" > "$(counter_file "$1")"
}

reset_counter() {
  set_counter "$1" 0
}

increment_counter() {
  component="$1"
  count="$(get_counter "$component")"
  count=$((count + 1))
  set_counter "$component" "$count"
  printf '%s' "$count"
}

maybe_reboot() {
  component="$1"
  count="$2"
  threshold="$REBOOT_THRESHOLD_CRITICAL"
  case "$component" in
    wan) threshold="$WAN_REBOOT_THRESHOLD" ;;
  esac

  if [ "$count" -ge "$threshold" ]; then
    marker="$STATE_DIR/rebooted_${component}"
    if [ ! -f "$marker" ]; then
      log_line "$component" "FAIL" "failcount=$count threshold=$threshold rebooting router"
      date '+%s' > "$marker" 2>/dev/null || true
      sync
      reboot
      exit 0
    fi
    log_line "$component" "FAIL" "failcount=$count threshold=$threshold reboot already requested"
  fi
}

run_check() {
  script="$1"
  component="$(basename "$script" .sh | sed 's/^check-//')"
  tmp="/tmp/icxifi-watchdog-${component}.$$"

  if "$script" > "$tmp" 2>&1; then
    rc=0
  else
    rc=$?
  fi

  if [ -s "$tmp" ]; then
    while IFS='|' read -r status message || [ -n "$status" ]; do
      [ -n "$status" ] || continue
      [ -n "$message" ] || message="check completed"
      log_line "$component" "$status" "$message"
    done < "$tmp"
  else
    if [ "$rc" -eq 0 ]; then
      log_line "$component" "OK" "check passed"
    else
      log_line "$component" "FAIL" "check failed with no output"
    fi
  fi
  rm -f "$tmp"

  if [ "$rc" -eq 0 ]; then
    reset_counter "$component"
    rm -f "$STATE_DIR/rebooted_${component}" 2>/dev/null || true
  else
    count="$(increment_counter "$component")"
    log_line "$component" "FAIL" "consecutive failure count $count"
    case "$component" in
      opennds|sqlite) maybe_reboot "$component" "$count" ;;
    esac
  fi
}

for check in \
  "$CHECK_DIR/check-opennds.sh" \
  "$CHECK_DIR/check-uhttpd.sh" \
  "$CHECK_DIR/check-api.sh" \
  "$CHECK_DIR/check-sqlite.sh" \
  "$CHECK_DIR/check-wan.sh"; do
  [ -x "$check" ] || continue
  run_check "$check"
done
