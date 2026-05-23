#!/bin/sh
set -u
export PATH="/usr/sbin:/usr/bin:/sbin:/bin"

check_opennds() {
  pgrep opennds >/dev/null 2>&1 || return 1
  ndsctl status >/dev/null 2>&1 || return 1
}

if check_opennds; then
  echo "OK|service healthy"
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
