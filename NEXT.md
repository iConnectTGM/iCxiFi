# iCxiFi - Next

## Completed

- [x] Cloud API (Node.js/Express + MongoDB Atlas)
- [x] Router authentication, activation, heartbeat, config pull/apply
- [x] Captive portal flow (OpenNDS + custom iCxiFi UI)
- [x] Voucher create/redeem and session tracking
- [x] Account-wide direct grant flow (`/api/router/grants/*`) with pause/resume/state
- [x] ESP offline pool + pending sales sync
- [x] Client dashboard auth: register/login/forgot-password/reset
- [x] Router/client transfer flows (ownership + license transfer requests)
- [x] Router edit modal:
  - [x] SSID and split 2.4G/5G SSID
  - [x] Per-rate hours/minutes + DL/UL Mbps
  - [x] DL/UL calibration per router
- [x] Router list sales visibility:
  - [x] Sales Today
  - [x] Total Sales
  - [x] Clear Sales action in router 3-dot menu
- [x] Admin dashboard baseline (`/admin`) with router/voucher/session views
- [x] Health endpoint and global error handling
- [x] ESP router-local contract smoke test script (`router/openwrt/tests/esp_contract_smoke.sh`)

---

## Hardening status

See `router/openwrt/HARDENING.md`.

- [x] Router credential permission checks in CGI
- [x] Input sanitization and basic request validation
- [x] Rate limiting in vend/redeem CGI
- [x] Log rotation for `/tmp/icxifi_auth_debug.log`
- [x] Trusted MAC bypass removed in normal flow
- [x] BinAuth compatibility/session restore kept
- [ ] Optional advanced hardening: signed firmware, anti-clone, encrypted key storage

---

## Current priorities

- [ ] Add one-click "Apply to Router Now" from Client UI (command queue trigger)
- [ ] Add range selector for router list sales (Today/Week/Month)
- [ ] Add "clear by date range" sales option (per router + tenant-wide)
- [ ] Improve mobile UX polish for portal and dashboard tables/modals
- [ ] Add automated tests for:
  - [ ] grants topup/pause/resume/state
  - [ ] transfer accept/cancel/reject flows
  - [ ] router profile update + calibration persistence

---

## Later

- [ ] RBAC expansion (admin/operator/client scopes)
- [ ] Billing/plan limits integration
- [ ] CI/CD pipeline for API + dashboard + router package
