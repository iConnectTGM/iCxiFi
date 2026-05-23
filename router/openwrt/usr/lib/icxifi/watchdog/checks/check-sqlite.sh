#!/bin/sh
set -u
export PATH="/usr/sbin:/usr/bin:/sbin:/bin"

DB="${ICXIFI_DB:-/etc/icxifi/icxifi.db}"
BACKUP_DIR="/etc/icxifi/backup"
STATE_DIR="/usr/lib/icxifi/watchdog/state"
GOOD_MARKER="$STATE_DIR/last_good_sqlite_backup"

backup_good_db() {
  mkdir -p "$BACKUP_DIR" "$STATE_DIR"
  now="$(date +%s)"
  last="$(cat "$GOOD_MARKER" 2>/dev/null || echo 0)"
  case "$last" in ''|*[!0-9]*) last=0 ;; esac
  if [ $((now - last)) -ge 3600 ] || ! ls "$BACKUP_DIR"/icxifi-good-*.db >/dev/null 2>&1; then
    cp "$DB" "$BACKUP_DIR/icxifi-good-$now.db" 2>/dev/null || true
    printf '%s\n' "$now" > "$GOOD_MARKER" 2>/dev/null || true
    ls -1t "$BACKUP_DIR"/icxifi-good-*.db 2>/dev/null | sed -n '4,$p' | xargs -r rm -f
  fi
}

if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "FAIL|sqlite3 command missing"
  exit 1
fi

if [ ! -s "$DB" ]; then
  echo "FAIL|database missing"
  exit 1
fi

result="$(sqlite3 "$DB" 'PRAGMA integrity_check;' 2>/tmp/icxifi-sqlite-check.err || true)"
if [ "$result" = "ok" ]; then
  backup_good_db
  echo "OK|integrity_check passed"
  exit 0
fi

mkdir -p "$BACKUP_DIR"
ts="$(date +%s)"
cp "$DB" "$BACKUP_DIR/icxifi-corrupt-$ts.db" 2>/dev/null || true
echo "FAIL|integrity_check failed; corrupt copy saved"

latest="$(ls -1t "$BACKUP_DIR"/icxifi-good-*.db 2>/dev/null | head -n 1 || true)"
if [ -n "$latest" ] && sqlite3 "$latest" 'PRAGMA integrity_check;' 2>/dev/null | grep -qx ok; then
  cp "$latest" "$DB" 2>/dev/null && {
    echo "OK|restored latest good backup"
    exit 0
  }
fi

exit 1
