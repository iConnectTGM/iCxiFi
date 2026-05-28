#!/bin/sh
set -u
export PATH="/usr/sbin:/usr/bin:/sbin:/bin"

check_opennds() {
  pgrep opennds >/dev/null 2>&1 || return 1
  ndsctl status >/tmp/icxifi_watchdog_ndsctl.out 2>&1 &
  nds_pid="$!"
  waited=0
  while kill -0 "$nds_pid" 2>/dev/null; do
    if [ "$waited" -ge 5 ]; then
      kill "$nds_pid" 2>/dev/null || true
      return 1
    fi
    sleep 1
    waited=$((waited + 1))
  done
  wait "$nds_pid" || return 1
}

if check_opennds; then
  echo "OK|service healthy"
  exit 0
fi

if pgrep opennds >/dev/null 2>&1; then
  echo "OK|service running, ndsctl busy"
  exit 0
fi

echo "FAIL|restarting service"
/etc/init.d/opennds restart >/dev/null 2>&1 || true
sleep 3

if check_opennds; then
  echo "OK|service recovered"
  exit 0
fi

echo "FAIL|service still unhealthy after restart"
exit 1
