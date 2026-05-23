#!/bin/sh
set -u
export PATH="/usr/sbin:/usr/bin:/sbin:/bin"

URL="${ICXIFI_API_HEALTH_URL:-http://127.0.0.1:2080/cgi-bin/icxifi/api/v1/heartbeat}"

check_api() {
  wget -qO- -T 8 "$URL" 2>/dev/null | grep -q '"ok"[[:space:]]*:[[:space:]]*true'
}

if check_api; then
  echo "OK|local api healthy"
  exit 0
fi

echo "FAIL|local api unhealthy; restarting uhttpd"
if [ -x /etc/init.d/icxifi-api ]; then
  /etc/init.d/icxifi-api restart >/dev/null 2>&1 || true
else
  /etc/init.d/uhttpd restart >/dev/null 2>&1 || true
fi
sleep 2

if check_api; then
  echo "OK|local api recovered"
  exit 0
fi

echo "FAIL|local api still unhealthy"
exit 1
