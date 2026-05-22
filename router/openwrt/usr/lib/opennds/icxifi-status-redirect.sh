#!/bin/sh
# iCxiFi: Replace openNDS status page with redirect to our FAS portal
# Use gateway IP (IP works in iOS CPD; hostnames can NXDOMAIN when device uses external DNS)
set -e
GW="$(uci get network.lan.ipaddr 2>/dev/null | cut -d/ -f1)"
GW="${GW:-$(cat /etc/icxifi/gateway_ip 2>/dev/null | tr -d '\r\n' | cut -d/ -f1)}"
GW="${GW:-10.0.0.1}"
cat <<EOF
<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=http://${GW}:2080/cgi-bin/icxifi/portal_redirect"><script>location.replace("http://${GW}:2080/cgi-bin/icxifi/portal_redirect");</script><title>iCxiFi WiFi</title></head><body><p>Redirecting to WiFi login...</p><a href="http://${GW}:2080/cgi-bin/icxifi/portal_redirect">Click here</a></body></html>
EOF
