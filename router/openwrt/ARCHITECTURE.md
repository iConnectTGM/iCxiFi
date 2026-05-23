# iCxiFi Commercial Stable Architecture

This is the target direction for the router bundle. The guiding rule is:

```text
coin or voucher event -> local router save -> openNDS auth -> cloud sync later
```

The cloud is used for analytics, licensing, dashboard, OTA, and reconciliation. It is not in the critical path for granting internet access.

## Phase A: Core Local Engine

Current migration state:

- Existing CGI endpoints remain stable: `/cgi-bin/icxifi/esp_vend`, `/redeem`, `/session`, `/pause`, `/resume`.
- Versioned local API aliases are added under `/cgi-bin/icxifi/api/v1/`.
- SQLite schema and bootstrap live under `/usr/lib/icxifi/db/`.
- Sync queue workers live under `/usr/lib/icxifi/sync/`.
- Successful coin/voucher grants write sales and sessions into SQLite. Sales are
  queued in SQLite `sync_queue`; the old flat-file queue is only a fallback when
  SQLite is unavailable.
- Session status, pause, resume, and expiry now prefer SQLite `sessions`, with
  `/tmp/icxifi_sessions` and `/tmp/icxifi_paused` kept as compatibility fallback.
- Voucher inventory and local voucher redemption now prefer SQLite `vouchers`,
  with `/etc/icxifi/voucher_pool.txt` kept as compatibility fallback.

Target runtime paths:

```text
/usr/lib/icxifi/
├── api/
├── auth/
├── sessions/
├── vouchers/
├── queue/
├── sync/
├── watchdog/
├── config/
├── utils/
└── db/
```

## Local API

The stable v1 API paths are:

```text
/cgi-bin/icxifi/api/v1/coin
/cgi-bin/icxifi/api/v1/voucher/redeem
/cgi-bin/icxifi/api/v1/session/status
/cgi-bin/icxifi/api/v1/session/pause
/cgi-bin/icxifi/api/v1/session/resume
/cgi-bin/icxifi/api/v1/heartbeat
/cgi-bin/icxifi/api/v1/health
/cgi-bin/icxifi/api/v1/sync/push
/cgi-bin/icxifi/api/v1/router/config
```

For compatibility, these initially wrap the proven CGI scripts. Later phases can move their internals directly to SQLite-backed modules without changing ESP or portal URLs.

`/api/v1/heartbeat` is intentionally tiny for watchdog use. `/api/v1/health`
is the richer diagnostic endpoint for service state, SQLite integrity, queue
depth, voucher/session counts, WAN, and cloud reachability.

## SQLite

Database file:

```text
/etc/icxifi/icxifi.db
```

Tables:

- `routers`
- `sessions`
- `vouchers`
- `sales_events`
- `sync_queue`
- `meta`

The installer attempts to install `sqlite3-cli` and runs:

```sh
/usr/lib/icxifi/db/init
```

If SQLite is not installed, existing flat-file fallback behavior continues.

## Sync

The sync queue worker runs every 2 minutes:

```text
*/2 * * * * /usr/lib/icxifi/sync/queue_worker
*/5 * * * * /usr/lib/icxifi/sessions/cleanup
17 * * * * /usr/lib/icxifi/vouchers/cleanup
```

Legacy `/etc/icxifi/pending_sales.txt` remains supported through `/usr/bin/icxifi-sync-pending`
for fallback and old queued entries.

## ESP Direction

The ESP remains a peripheral:

- coin pulse detection
- display/audio/LEDs
- local API request
- retry queue

It should not own sessions, vouchers, or hotspot auth logic.

Preferred coin call when a client is known:

```text
GET /cgi-bin/icxifi/api/v1/coin?amount=5&deviceId=vendo-1&clientIp=10.0.0.123
```

## Next Phases

Phase B:

- HMAC SHA256 ESP request signing
- router watchdog
- retry and reconciliation hardening

Watchdog layout:

```text
/usr/lib/icxifi/watchdog/
├── icxifi-watchdog.sh
├── checks/
│   ├── check-opennds.sh
│   ├── check-uhttpd.sh
│   ├── check-sqlite.sh
│   ├── check-wan.sh
│   └── check-api.sh
├── logs/
└── state/
```

It runs once per minute, restarts failed services first, and only reboots on repeated critical failures.

ESP HMAC is enforced per device when either of these files exists:

```text
/etc/icxifi/esp_secret
/etc/icxifi/esp_secrets/{deviceId}
```

Create one with:

```sh
/usr/lib/icxifi/config/esp-secret vendo-1
```

Phase C:

- signed OTA update flow
- rollback
- multi-router voucher roaming

Phase D:

- reseller SaaS
- QR payments
- advanced bandwidth policy
