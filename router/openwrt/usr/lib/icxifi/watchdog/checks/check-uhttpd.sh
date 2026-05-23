#!/bin/sh
set -u
export PATH="/usr/sbin:/usr/bin:/sbin:/bin"

check_uhttpd() {
  pgrep uhttpd >/dev/null 2>&1 || return 1
  wget -qO- -T 5 http://127.0.0.1/ >/dev/null 2>&1 || return 1
}

if check_uhttpd; then
  echo "OK|service healthy"
  exit 0
fi

echo "FAIL|restarting service"
/etc/init.d/uhttpd restart >/dev/null 2>&1 || true
sleep 2

if check_uhttpd; then
  echo "OK|service recovered"
  exit 0
fi

echo "FAIL|service still unhealthy after restart"
exit 1
