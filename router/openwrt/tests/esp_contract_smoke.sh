#!/bin/sh
# iCxiFi ESP router-local contract smoke test
# Run on OpenWrt router shell:
#   sh /root/esp_contract_smoke.sh
# Optional real vend test (creates a voucher):
#   RUN_VEND=1 AMOUNT=5 DEVICE_ID=vendo-1 sh /root/esp_contract_smoke.sh

set -eu

BASE_URL="${BASE_URL:-http://127.0.0.1:2080/cgi-bin/icxifi}"
RUN_VEND="${RUN_VEND:-0}"
AMOUNT="${AMOUNT:-5}"
DEVICE_ID="${DEVICE_ID:-esp-test}"

PASS=0
FAIL=0

say() {
  printf '%s\n' "$*"
}

pass() {
  PASS=$((PASS + 1))
  say "[PASS] $*"
}

fail() {
  FAIL=$((FAIL + 1))
  say "[FAIL] $*"
}

is_uint() {
  case "$1" in
    ''|*[!0-9]*) return 1 ;;
    *) return 0 ;;
  esac
}

http_get() {
  endpoint="$1"
  resp="$(curl -sS -m 15 "${BASE_URL}/${endpoint}" -w '\n%{http_code}' 2>/dev/null || true)"
  body="$(printf '%s' "$resp" | sed '$d')"
  code="$(printf '%s' "$resp" | tail -n1 | tr -cd '0-9')"
  [ -z "$code" ] && code="0"
  printf '%s\n%s\n' "$code" "$body"
}

assert_contains() {
  body="$1"
  token="$2"
  name="$3"
  if printf '%s' "$body" | grep -q "$token"; then
    pass "$name"
  else
    fail "$name (missing token: $token)"
  fi
}

say "== iCxiFi ESP Contract Smoke Test =="
say "BASE_URL=${BASE_URL}"
say "RUN_VEND=${RUN_VEND} AMOUNT=${AMOUNT} DEVICE_ID=${DEVICE_ID}"
say ""

# 1) /activation
res="$(http_get "activation")"
code="$(printf '%s' "$res" | sed -n '1p')"
body="$(printf '%s' "$res" | sed '1d')"
if [ "$code" = "200" ]; then
  pass "/activation http 200"
else
  fail "/activation http $code"
fi
assert_contains "$body" '"activated"' "/activation has activated"
assert_contains "$body" '"routerId"' "/activation has routerId"

# 2) /state
res="$(http_get "state")"
code="$(printf '%s' "$res" | sed -n '1p')"
body="$(printf '%s' "$res" | sed '1d')"
if [ "$code" = "200" ]; then
  pass "/state http 200"
else
  fail "/state http $code"
fi
assert_contains "$body" '"state"' "/state has state"
assert_contains "$body" '"routerId"' "/state has routerId"

# 3) /profile
res="$(http_get "profile")"
code="$(printf '%s' "$res" | sed -n '1p')"
body="$(printf '%s' "$res" | sed '1d')"
if [ "$code" = "200" ]; then
  pass "/profile http 200"
else
  fail "/profile http $code"
fi
assert_contains "$body" '"rates"' "/profile has rates"

# 4) Optional vend test
if [ "$RUN_VEND" = "1" ]; then
  if ! is_uint "$AMOUNT"; then
    fail "vend amount must be integer"
  else
    endpoint="esp_vend?amount=${AMOUNT}&deviceId=${DEVICE_ID}"
    res="$(http_get "$endpoint")"
    code="$(printf '%s' "$res" | sed -n '1p')"
    body="$(printf '%s' "$res" | sed '1d')"

    if [ "$code" = "200" ]; then
      pass "/esp_vend http 200"
      assert_contains "$body" '"ok":true' "/esp_vend ok=true"
      assert_contains "$body" '"code"' "/esp_vend has voucher code"
      assert_contains "$body" '"minutes"' "/esp_vend has minutes"
    elif [ "$code" = "429" ]; then
      fail "/esp_vend rate limited (429) - retry later"
    else
      fail "/esp_vend http $code body=$body"
    fi
  fi
else
  say "[SKIP] /esp_vend (set RUN_VEND=1 to include live vend)"
fi

say ""
say "Result: PASS=${PASS} FAIL=${FAIL}"
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
