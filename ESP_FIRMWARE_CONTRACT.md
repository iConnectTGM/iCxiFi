# ESP Firmware Endpoint Contract (iCxiFi Router Local API)

This is the exact contract for ESP coin-slot devices (Wi-Fi or LAN) talking to the local router CGI.

## 1) Base URL

- Base: `http://10.0.0.1:2080/cgi-bin/icxifi`
- Transport: HTTP `GET`
- Auth: none (local LAN only)
- Response type: JSON (`Content-Type: application/json`)

Use the same contract for:
- `wireless` ESP (ESP joins router SSID)
- `landbase` ESP (ESP Ethernet to router LAN)

---

## 2) Required device behavior (firmware)

- Convert coin pulses to integer `amount` (PHP).
- Send one vend request per accepted coin event.
- Display returned voucher code to user.
- Handle rate-limit and temporary cloud errors with retry policy below.
- Do not store cloud API keys in ESP.

---

## 3) Endpoints

## 3.1 Check activation/ready state

### `GET /activation`

Purpose:
- Check if router is activated in cloud (credentials valid).

Success response:
```json
{"activated":true,"routerId":"9c:ce:88:48:41:9f","licenseKey":"ICXF-..."}
```

Not activated:
```json
{"activated":false,"routerId":"9c:ce:88:48:41:9f"}
```

Firmware rule:
- If `activated=false`, disable coin vend and show `NOT ACTIVATED`.

---

## 3.2 Router status (optional richer check)

### `GET /state`

Purpose:
- Returns cloud-derived/local fallback router state.

Possible success:
```json
{"ok":true,"routerId":"9c:ce:88:48:41:9f","state":"active","status":"active","licenseKey":"ICXF-..."}
```

Possible fallback:
```json
{"ok":false,"routerId":"9c:ce:88:48:41:9f","state":"no_license","status":"unknown","error":"cloud_unreachable","httpCode":0}
```

Firmware rule:
- Allow vending only when state is active (or when your business rule allows offline pool fallback).

---

## 3.3 Create voucher from coin (primary ESP API)

### `GET /esp_vend?amount={int}&deviceId={id}[&macHint={mac}]`

Query params:
- `amount` (required): unsigned integer, e.g. `5`, `10`, `20`
- `deviceId` (optional but recommended): `A-Za-z0-9._:-` only  
  Example: `vendo-1`
- `macHint` (optional): target client MAC (`AA:BB:CC:DD:EE:FF`) if you capture it

Example:
```http
GET /cgi-bin/icxifi/esp_vend?amount=10&deviceId=vendo-1
```

Success (cloud):
```json
{"ok":true,"code":"ICXF7E8A0","minutes":35,"amount":10,"expiresAt":"2026-02-24T12:34:56.000Z"}
```

Success (offline pool fallback):
```json
{"ok":true,"code":"ICXF7E8A0","minutes":35,"amount":10,"expiresAt":"2026-02-24T12:34:56.000Z","offline":true}
```

Error examples:
- `400` invalid input
```json
{"ok":false,"error":"amount must be numeric"}
```
- `429` local rate limit
```json
{"ok":false,"error":"Rate limit exceeded","retryAfterSeconds":4}
```
- `500` router credential/config issue
```json
{"ok":false,"error":"Missing router cloud credentials"}
```
- `502` cloud unavailable
```json
{"ok":false,"error":"Cloud unavailable"}
```

Voucher code format accepted in system:
- `^(ICXF-)?[A-Z0-9]{4,32}$`

---

## 3.4 Profile/rates (optional, for ESP UI)

### `GET /profile`

Purpose:
- Read current router profile/rates for local display or vending table.

Important fields:
- `profile.rates[].amount`
- `profile.rates[].minutes`

---

## 4) Firmware retry and timeout policy

Recommended:
- Connect timeout: `3-5s`
- Read timeout: `20s`
- Total request deadline: `25s`

Retry rules:
- On `429`: wait `retryAfterSeconds` then retry once.
- On network error or `5xx`: retry once with backoff (`1-2s`).
- On `400`: do not retry (fix input).

Critical anti-duplicate rule:
- Keep a local `coin_event_id` and `pending` state in non-volatile memory.
- If response is unknown (timeout after send), mark event as `uncertain` and require operator/user recovery flow before auto-vending again, to avoid double vend.

---

## 5) Minimal firmware state machine

1. Boot -> call `/activation`.
2. If not activated -> `LOCKED`.
3. If activated -> `READY`.
4. Coin inserted -> create `coin_event_id`, call `/esp_vend`.
5. If `ok=true` -> show/print code, mark event `done`.
6. If temporary failure -> retry per policy.
7. If permanent failure -> mark `failed`, show error.

---

## 6) Security notes

- Put ESP in trusted local network/VLAN (not open client network).
- Never embed cloud key/license secrets in ESP firmware.
- Keep router as single cloud-facing authority.

