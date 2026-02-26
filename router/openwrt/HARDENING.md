# iCxiFi OpenWrt Hardening Runbook

Target: OpenWrt 24.10.x + openNDS 10.3.1

## 1) Credential file security

Enforce cloud credential files before serving vend/redeem:

```sh
ls -l /etc/icxifi/cloud_base_url /etc/icxifi/router_id /etc/icxifi/router_api_key
chmod 600 /etc/icxifi/router_api_key
chown root:root /etc/icxifi/router_api_key
```

Required:
- `/etc/icxifi/cloud_base_url` exists and is non-empty
- `/etc/icxifi/router_id` exists and is non-empty
- `/etc/icxifi/router_api_key` exists and is non-empty
- `/etc/icxifi/router_api_key` is mode `600`, owned by root

`/www/cgi-bin/icxifi/vend` and `/www/cgi-bin/icxifi/esp_vend` enforce these checks.

## 2) Logging policy

Standard log path:
- `/tmp/icxifi_auth_debug.log`

Policy:
- Log is capped/rotated by CGI scripts (rename to `.1` after size threshold).
- Never log API keys or Authorization headers.
- Log only operational fields: IP, voucher code, amount, timeout math, ndsctl result.

Useful commands:

```sh
tail -n 100 /tmp/icxifi_auth_debug.log
wc -c /tmp/icxifi_auth_debug.log
```

## 3) Input sanitization

Enforced in CGI:
- `amount` and `minutes`: numeric only
- voucher code regex: `^(ICXF-)?[A-Z0-9]{4,32}$`
- `deviceId`: `[A-Za-z0-9._:-]+`
- MAC hint: `[A-Fa-f0-9:-]+`

Do not trust user-passed client IP.
- `vend` and `redeem` use `REMOTE_ADDR` server-side.

## 4) Lightweight per-client rate limiting

CGI per-IP limiter (10-second window) is enforced using:
- `/tmp/icxifi_rl_<ip>`

Default threshold:
- `8` requests / `10` seconds

Tune by env var:

```sh
export ICXIFI_RL_MAX_REQUESTS=12
```

## 5) Trusted MAC lockdown

Default must be no trusted bypass MACs:

```sh
uci -q delete opennds.@opennds[0].trustedmac
uci commit opennds
/etc/init.d/opennds restart
```

Verify:

```sh
uci show opennds | grep -i trusted || true
```

## 6) Walled garden and ports

Only keep what is required for captive flow:
- local portal/CGI: `2080`

```sh
uci -q delete opennds.@opennds[0].walledgarden_port
uci add_list opennds.@opennds[0].walledgarden_port='2080'
uci commit opennds
/etc/init.d/opennds restart
```

## 7) Preemptive authentication behavior

Keep enabled for iCxiFi auto-auth vend flow:

```sh
uci set opennds.@opennds[0].allow_preemptive_authentication='1'
uci commit opennds
/etc/init.d/opennds restart
```

Reason:
- vend/redeem CGI calls `ndsctl auth` for preauth clients and CPD scenarios.

## 8) Session restore resilience (BinAuth)

The default openNDS BinAuth script (`/usr/lib/opennds/binauth_log.sh`) manages the authenticated client database and enables automatic session restore after restart. When vend/redeem call `ndsctl auth`, BinAuth logs the client; openNDS then re-authenticates clients with remaining session time on restart.

**Critical:** Do NOT override BinAuth:

```sh
# BAD - disables auth_restore and session restore
# uci set opennds.@opennds[0].binauth='/usr/lib/opennds/my_script.sh'
```

The install script does not set `option binauth`, preserving the default. Verify:

```sh
uci show opennds | grep binauth || echo "No custom binauth (correct)"
```

Optional: Use the custom hook `/usr/lib/opennds/custombinauth.sh` (called by default binauth) for iCxiFi-specific logging without disabling restore.

## 9) Acceptance checklist

```sh
# service and listener checks
/etc/init.d/opennds status
netstat -lntp | egrep '2050|2080'

# inspect captive client state
ndsctl status
ndsctl json

# portal reachability
wget -qO- http://172.22.0.1:2050/opennds_preauth/icxifi/index.html | head

# test vend and redeem locally (from captive client network)
curl -s "http://172.22.0.1:2080/cgi-bin/icxifi/vend?amount=10&deviceId=vendo-1"
curl -s "http://172.22.0.1:2080/cgi-bin/icxifi/redeem?code=ICXF-ABCDEFGH"

# logs
logread | tail -n 100
tail -n 100 /tmp/icxifi_auth_debug.log
```
