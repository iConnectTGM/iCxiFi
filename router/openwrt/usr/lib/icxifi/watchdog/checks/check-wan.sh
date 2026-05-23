#!/bin/sh
set -u
export PATH="/usr/sbin:/usr/bin:/sbin:/bin"

ping_ok() {
  ping -c 2 -W 2 "$1" >/dev/null 2>&1
}

if ip link show wan 2>/dev/null | grep -q 'NO-CARRIER'; then
  echo "FAIL|wan physical link has no carrier"
  exit 1
fi

if ping_ok 1.1.1.1 || ping_ok 8.8.8.8; then
  echo "OK|internet reachable"
  exit 0
fi

cloud_base="$(tr -d '\r\n' < /etc/icxifi/cloud_base_url 2>/dev/null || true)"
if [ -n "$cloud_base" ] && command -v curl >/dev/null 2>&1; then
  if curl -fsS --connect-timeout 5 -m 10 "$cloud_base/api/health" >/dev/null 2>&1; then
    echo "OK|internet reachable via cloud health"
    exit 0
  fi
fi

echo "FAIL|wan unreachable; cycling wan"
ifdown wan >/dev/null 2>&1 || true
sleep 2
ifup wan >/dev/null 2>&1 || true
sleep 8

if ping_ok 1.1.1.1 || ping_ok 8.8.8.8; then
  echo "OK|wan recovered"
  exit 0
fi
if [ -n "$cloud_base" ] && command -v curl >/dev/null 2>&1; then
  if curl -fsS --connect-timeout 5 -m 10 "$cloud_base/api/health" >/dev/null 2>&1; then
    echo "OK|wan recovered via cloud health"
    exit 0
  fi
fi

echo "FAIL|wan still unreachable"
exit 1
