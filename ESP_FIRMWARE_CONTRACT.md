# iCxiFi ESP8266 Firmware Contract

The ESP8266 is a peripheral terminal. It detects coin pulses, provides display/audio/LED feedback, and calls the router's local API. It must not store cloud API keys, own the voucher database, compute hotspot sessions, or authorize clients directly.

## Runtime Assumptions

- Router LAN: `10.0.0.1`
- Local API port: `2080`
- API base: `http://10.0.0.1:2080/cgi-bin/icxifi/api/v1`
- Legacy API base remains available: `http://10.0.0.1:2080/cgi-bin/icxifi`

## Required ESP Behavior

- Convert coin pulses to integer PHP `amount`.
- Debounce pulses and reject noisy/duplicate pulses.
- Keep a local retry queue for accepted coin events that fail to submit.
- Use watchdog/restart protection.
- Send one request per accepted vend event.
- If the phone/client IP or MAC is known, include it so the router can grant internet immediately.
- Display a returned voucher code only when the router cannot identify a unique target client.

## Coin / Local Grant

```http
GET /cgi-bin/icxifi/api/v1/coin?amount={int}&deviceId={id}[&clientIp={ip}][&clientMac={mac}]
```

Query params:

- `amount` required: unsigned integer, e.g. `5`, `10`, `20`
- `deviceId` recommended: `A-Za-z0-9._:-`, e.g. `vendo-1`
- `clientIp` optional: captive client IP, e.g. `10.0.0.178`
- `clientMac` optional: captive client MAC
- `macHint` legacy alias for `clientMac`

Example:

```http
GET /cgi-bin/icxifi/api/v1/coin?amount=5&deviceId=vendo-1&clientIp=10.0.0.178
```

Success when router grants locally:

```json
{"ok":true,"mode":"coin_local","offline":true,"synced":false,"code":"COIN-1779430000-5","grant":{"minutes":15,"downloadKbps":10000,"uploadKbps":10000},"client":{"ip":"10.0.0.178","mac":"AA:BB:CC:DD:EE:FF"}}
```

Success when no unique target client is known:

```json
{"ok":true,"mode":"voucher_pool","code":"ZTKCX36U","minutes":15,"amount":5,"expiresAt":"2026-05-23T09:25:18.348Z","offline":true}
```

Error examples:

```json
{"ok":false,"error":"amount must be numeric"}
```

```json
{"ok":false,"error":"No target client and no voucher pool available"}
```

## Voucher Redeem

The portal calls:

```http
GET /cgi-bin/icxifi/api/v1/voucher/redeem?code={code}
```

Voucher format:

```text
^(ICXF-)?[A-Z0-9]{4,32}$
```

Router behavior:

1. Check local SQLite/voucher pool.
2. Authenticate client through openNDS.
3. Mark local sale/session.
4. Queue cloud sync.
5. Fall back to cloud redeem only when the voucher is not local.

## ESP Event State Machine

1. Boot.
2. Load config.
3. If router API unavailable, keep retrying locally.
4. Coin inserted.
5. Create local `coin_event_id`.
6. Call `/api/v1/coin`.
7. If `mode=coin_local`, access is already granted.
8. If `mode=voucher_pool` or `mode=voucher_cloud`, display or print the voucher code.
9. If temporary failure, retry.
10. If permanent failure, mark failed and show error.

## Future Security

Phase B should add ESP-to-router request signing:

- HMAC SHA256
- timestamp
- nonce
- per-device secret

The router should reject replayed or expired requests.
