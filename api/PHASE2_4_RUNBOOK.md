# iCxiFi Phase 2-4 Runbook

## Health check (no auth)

```bash
curl -s http://localhost:4000/api/health
```

Returns: `{ "ok": true, "db": "connected", "uptimeSec": N }`

## Admin dashboard (Phase 7)

1. Set `ADMIN_API_KEY` in `.env` and **restart the API**
2. Open `http://localhost:4000/admin` (must be from the same host as the API)
3. Enter the Admin API key exactly as in `.env` and click Continue
4. View routers, vouchers, and sessions

**If Continue does nothing:** Check browser DevTools (F12 → Console) for errors. Ensure the API is running and `ADMIN_API_KEY` in `.env` matches. Restart the API after changing `.env`.

## Quick test (PowerShell)

```powershell
cd D:\iCxiFi\api
# Use YOUR router ID and API key from seed output:
.\test-api.ps1 -Rid "00-00-00-00-00-01" -ApiKey "3a5b123d4e5f6g7h"
```

## 1) Install and run API

```bash
cd api
npm install
npm run dev
```

## 2) Seed router (hybrid profile + hashed API key)

```bash
cd api
SEED_ROUTER_ID="10:82:3d:54:6e:fe" \
SEED_ROUTER_API_KEY="rk_live_replace_me" \
SEED_ROUTER_NAME="Ruijie EW1200G Pro" \
node scripts/seed_router.js
```

## 3) Router-auth curl variables

```bash
BASE="http://localhost:4000"
RID="10:82:3d:54:6e:fe"
APIKEY="rk_live_replace_me"
AUTHH="Authorization: Bearer $APIKEY"
RIDH="X-Router-ID: $RID"
```

## 4) Phase 2 tests

### heartbeat

```bash
curl -s -X POST "$BASE/api/router/heartbeat" \
  -H "$AUTHH" -H "$RIDH" -H "Content-Type: application/json" \
  -d '{"uptimeSec":12345,"fwVersion":"24.10.5-ruijie-ew1200gpro","wanIp":"1.2.3.4","lanIp":"172.22.0.1"}'
```

### config (Phase 2.2 + Phase 3 full config)

```bash
curl -s -X GET "$BASE/api/router/config" -H "$AUTHH" -H "$RIDH"
```

Response includes: `ok`, `routerId`, `status`, `profile`, `hotspot`, `portal`, `commands`.

## 5) Phase 3 — Config Sync (Remote Manage)

Set `ADMIN_API_KEY` in `.env` (e.g. `ADMIN_API_KEY=my_secret_admin_key_32_chars_min`).

```bash
ADMINH="X-Admin-API-Key: my_secret_admin_key_32_chars_min"
```

### update router config (hotspot, portal, status, profile)

```bash
curl -s -X PATCH "$BASE/api/admin/routers/$RID/config" \
  -H "$ADMINH" -H "Content-Type: application/json" \
  -d '{"status":"active","hotspot":{"ssid":"iCxiFi Guest","welcomeMsg":"Welcome"},"portal":{"theme":"default"}}'
```

### suspend router

```bash
curl -s -X PATCH "$BASE/api/admin/routers/$RID/config" \
  -H "$ADMINH" -H "Content-Type: application/json" \
  -d '{"status":"disabled"}'
```

### push command (restart openNDS, etc.)

```bash
curl -s -X POST "$BASE/api/admin/routers/$RID/commands" \
  -H "$ADMINH" -H "Content-Type: application/json" \
  -d '{"type":"restart_opennds"}'
```

Allowed types: `restart_opennds`, `restart_wireless`, `rotate_key`, `pull_config`.

### ack commands (router calls after executing)

```bash
curl -s -X POST "$BASE/api/router/commands/ack" \
  -H "$AUTHH" -H "$RIDH" -H "Content-Type: application/json" \
  -d '{"ids":["<command_id_from_config>"]}'
```

## 6) Phase 3 (Voucher) tests

### create by amount

```bash
curl -s -X POST "$BASE/api/router/vouchers/create" \
  -H "$AUTHH" -H "$RIDH" -H "Content-Type: application/json" \
  -d '{"amount":10,"deviceId":"vendo-1","clientHint":{"mac":"AA:BB:CC:DD:EE:FF"}}'
```

### create by minutes

```bash
curl -s -X POST "$BASE/api/router/vouchers/create" \
  -H "$AUTHH" -H "$RIDH" -H "Content-Type: application/json" \
  -d '{"minutes":35,"deviceId":"vendo-1"}'
```

### redeem

```bash
curl -s -X POST "$BASE/api/router/vouchers/redeem" \
  -H "$AUTHH" -H "$RIDH" -H "Content-Type: application/json" \
  -d '{"code":"ICXF-ABCDEFGH","client":{"ip":"172.22.0.104","mac":"AA:BB:CC:DD:EE:FF"}}'
```

## 7) Phase 4 tests

### sales event

```bash
curl -s -X POST "$BASE/api/router/sales/event" \
  -H "$AUTHH" -H "$RIDH" -H "Content-Type: application/json" \
  -d '{"deviceId":"vendo-1","amount":10,"voucherCode":"ICXF-ABCDEFGH","ts":"2026-02-13T01:23:45.000Z"}'
```

### summary (includes activeSessionCount)

```bash
curl -s -X GET "$BASE/api/router/reports/summary?range=today" -H "$AUTHH" -H "$RIDH"
```

### voucher usage report (today or week)

```bash
curl -s -X GET "$BASE/api/router/reports/vouchers?range=today" -H "$AUTHH" -H "$RIDH"
curl -s -X GET "$BASE/api/router/reports/vouchers?range=week" -H "$AUTHH" -H "$RIDH"
```

### active sessions

```bash
curl -s -X GET "$BASE/api/router/reports/sessions/active" -H "$AUTHH" -H "$RIDH"
```

### session end (router reports client disconnect)

```bash
curl -s -X POST "$BASE/api/router/sessions/end" \
  -H "$AUTHH" -H "$RIDH" -H "Content-Type: application/json" \
  -d '{"clientIp":"172.22.0.104","clientMac":"AA:BB:CC:DD:EE:FF"}'
```

### rates with speed limits (admin config)

Per-rate `downloadKbps`, `uploadKbps`, `downloadQuotaKB`, `uploadQuotaKB` in profile. Redeem returns these in `grant`.

## Phase 5 — ESP Integration

### batch voucher create (offline pool)

Get pre-created vouchers for offline use when cloud is down:

```bash
curl -s -X POST "$BASE/api/router/vouchers/batch" \
  -H "$AUTHH" -H "$RIDH" -H "Content-Type: application/json" \
  -d '{"count":5,"deviceId":"pool"}'
```

### sync pending offline sales

Router pushes sales that happened while offline:

```bash
curl -s -X POST "$BASE/api/router/sales/sync" \
  -H "$AUTHH" -H "$RIDH" -H "Content-Type: application/json" \
  -d '{"items":[{"deviceId":"vendo-1","amount":10,"voucherCode":"ICXF-XXX","ts":"2026-02-18T12:00:00.000Z"}]}'
```

## 8) Error case tests

### invalid credentials

```bash
curl -s -X GET "$BASE/api/router/config" -H "Authorization: Bearer rk_live_bad" -H "$RIDH"
```

### voucher expired / already redeemed / not found

Use a known code and call `/api/router/vouchers/redeem` repeatedly:
- first success: redeemed
- second call: `Voucher already redeemed`
- expired/not found based on record state

### rate limit exceeded

Call create/redeem in a loop above configured profile limits (default create=60/min, redeem=120/min).

---

## 9) Deployment with ngrok or Cloudflare (when router can't reach local API)

Use when the router (e.g. OpenWrt) cannot reach your PC on the LAN (packet loss, firewall, different subnet). A tunnel exposes your local API to the internet so the router can reach it.

**Quick start:** Double-click `run-ngrok-4000.bat` or `run-cloudflare-4000.bat` in the project root.

### Setup

1. **Install ngrok:** https://ngrok.com/download (extract to e.g. `C:\ngrok`)
2. **Sign up & authtoken:** https://dashboard.ngrok.com/get-started/your-authtoken  
   Run once: `.\ngrok.exe config add-authtoken YOUR_AUTHTOKEN`
3. **Start API and ngrok:**
   ```powershell
   # Terminal 1
   cd D:\iCxiFi\api
   npm run dev
   ```
   ```powershell
   # Terminal 2
   cd C:\ngrok
   .\ngrok.exe http 4000
   ```
4. **Copy the Forwarding URL** (e.g. `https://xxxx.ngrok-free.app`)

### Router config

```bash
echo "https://YOUR-NGROK-URL.ngrok-free.app" > /etc/icxifi/cloud_base_url
/usr/bin/icxifi-pull-config
```

### DNS fix (if router can't resolve ngrok hostname)

If `icxifi-pull-config` or redeem fails with "Could not resolve host":

```bash
# Use Google DNS for external resolution
printf 'nameserver 8.8.8.8\nnameserver 8.8.4.4\n' > /etc/icxifi/resolv.upstream
uci set dhcp.@dnsmasq[0].noresolv='1'
uci set dhcp.@dnsmasq[0].resolvfile='/etc/icxifi/resolv.upstream'
uci commit dhcp
/etc/init.d/dnsmasq restart
/usr/bin/icxifi-pull-config
```

### Notes

- ngrok free tier assigns a new URL each time you restart ngrok; update `cloud_base_url` when it changes
- Keep both API and ngrok running while testing

---

## 10) Deployment with Cloudflare Tunnel (alternative to ngrok)

Cloudflare Quick Tunnels require no account. Use `run-cloudflare-4000.bat` or:

```powershell
# Install (one-time): winget install Cloudflare.cloudflared
cloudflared tunnel --url http://localhost:4000
```

Copy the `https://xxxx.trycloudflare.com` URL. On the router:

```bash
echo "https://YOUR-URL.trycloudflare.com" > /etc/icxifi/cloud_base_url
```

**Note:** Quick tunnel URLs change on restart. For a stable URL, use a [named tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/create-local-tunnel/) with your own domain.

