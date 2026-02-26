# iCxiFi OpenWrt Bundle

Target runtime:
- OpenWrt 24.10.x
- openNDS 10.3.1

This bundle provides:
- Captive portal UI at `/etc/opennds/htdocs/opennds_preauth/icxifi/`
- Router CGI endpoints at `/www/cgi-bin/icxifi/`
- Installer: `/usr/bin/icxifi-opennds-install`
- Hardening runbook: `HARDENING.md`

## Included CGI endpoints

- `vend` (create + redeem + ndsctl auth + session extend)
- `redeem` (manual voucher redeem)
- `profile` (profile cache passthrough + safe fallback)
- `esp_vend` (ESP/device flow, create only, no redeem)

## Quick deploy

1. **Copy and drag** the `router/openwrt/*` folder contents to the router (e.g. via WinSCP, FileZilla, or Windows explorer over SMB/network share). Preserve the directory structure: `usr/bin/` → `/usr/bin/`, `www/` → `/www/`, etc.
2. SSH to the router and run:
   ```sh
   chmod +x /usr/bin/icxifi-opennds-install
   /usr/bin/icxifi-opennds-install
   ```

## Updating scripts (copy & drag)

After code changes, copy these to the router (preserve paths):

| Local path | Router path |
|------------|-------------|
| `router/openwrt/usr/bin/icxifi-heartbeat` | `/usr/bin/icxifi-heartbeat` |
| `router/openwrt/usr/bin/icxifi-pull-config` | `/usr/bin/icxifi-pull-config` |
| `router/openwrt/usr/bin/icxifi-sync-pending` | `/usr/bin/icxifi-sync-pending` |
| `router/openwrt/usr/bin/icxifi-replenish-pool` | `/usr/bin/icxifi-replenish-pool` |
| `router/openwrt/usr/bin/icxifi-apply-config` | `/usr/bin/icxifi-apply-config` |
| `router/openwrt/www/cgi-bin/icxifi/activation` | `/www/cgi-bin/icxifi/activation` |
| `router/openwrt/www/cgi-bin/icxifi/bindcode` | `/www/cgi-bin/icxifi/bindcode` |
| `router/openwrt/www/cgi-bin/icxifi/activate` | `/www/cgi-bin/icxifi/activate` |

Then on the router: `chmod +x /usr/bin/icxifi-*` and `/usr/bin/icxifi-heartbeat` to test.

**Debug offline:** Run `icxifi-heartbeat debug` on the router to see the heartbeat response and HTTP code.

## Key behavior

- `allow_preemptive_authentication` is set to `1`.
- Trusted MAC list is cleared by default.
- Walled garden keeps local port 2080 for captive portal/CGI; external access is controlled by walled-garden host allowlist.
- `vend` uses `REMOTE_ADDR` as client identity for ndsctl auth.
- **Captive Portal Detection (CPD)**: Install adds DNS redirects for `captive.apple.com`, `connectivitycheck.gstatic.com`, `msftconnecttest.com`, etc. so Android/iOS/Windows auto-pop the portal when connecting to WiFi.

## Gateway IP (e.g. 10.0.0.1) → Captive Portal

The portal is served at **`http://GATEWAY_IP:2080/index.html`**.

The redirect uses **10.0.0.1** by default. The install adds 10.0.0.1 as an alias on br-lan if needed. For persistence across reboot, set LAN IP to 10.0.0.1 in Network → Interfaces.

If port 80 shows LuCI, edit the install script to set `fasport='2080'` and `walledgarden_port='2080'`.

## Portal does not auto-pop / "Have traffic" without login

**No pop-up:** Many newer phones use HTTPS for CPD. We cannot intercept HTTPS. User must manually open `http://GATEWAY_IP:2080` (e.g. `http://10.0.0.1:2080`). DHCP option 114 (RFC 8910) is enabled so devices that support it may auto-open the portal.

**Have traffic (internet) without logging in:** OpenNDS should block unauthenticated clients. If they get through:
1. Check OpenNDS: `ndsctl status` and `uci get opennds.@opennds[0].gatewayinterface` (should be `br-lan`).
2. From a connected phone before login: open `http://10.0.0.1` – should redirect to the portal. If you get LuCI or full web, interception may not be working.
3. Restart: `/etc/init.d/opennds restart` and `/etc/init.d/firewall restart`.

**If portal still doesn't auto-pop:**
1. Have the user open **http://GATEWAY_IP:2080** manually (e.g. `http://10.0.0.1:2080`).
2. Re-deploy and run: `/usr/bin/icxifi-opennds-install`
3. Verify: `curl -sI http://127.0.0.1/generate_204` → should show `302 Found` and `Location: http://10.0.0.1:2080/index.html`
4. Verify DNS: `uci show dhcp.@dnsmasq[0].address` should list CPD domains.

**Root or /index.html shows nothing:** Re-run the installer. Fallback: use `http://10.0.0.1:2080/index.html`.

## Phase 5: ESP offline-first

- `icxifi-replenish-pool` fetches vouchers from `/api/router/vouchers/batch`, stores in `/etc/icxifi/voucher_pool.txt`
- `icxifi-sync-pending` pushes `/etc/icxifi/pending_sales.txt` to `/api/router/sales/sync`
- When cloud is down, `esp_vend` uses vouchers from pool and queues sales for later sync

## Phase 3: Config sync

- `icxifi-pull-config` fetches config from cloud, saves to `/etc/icxifi/profile_cache.json`
- `icxifi-apply-config` applies status (suspended marker), executes commands, acks to cloud
- Add cron for periodic pull, e.g. every 5 min: `*/5 * * * * /usr/bin/icxifi-pull-config`

## Verify

```sh
/etc/init.d/opennds status
netstat -lntp | egrep '2050|2080'
curl -s "http://172.22.0.1:2080/cgi-bin/icxifi/profile"
curl -s "http://172.22.0.1:2080/cgi-bin/icxifi/vend?amount=10&deviceId=vendo-1"
ndsctl status
tail -n 80 /tmp/icxifi_auth_debug.log
```
