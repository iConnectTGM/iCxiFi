#!/bin/sh

json_escape() {
  printf '%s' "${1:-}" | sed 's/\\/\\\\/g; s/"/\\"/g; s/\r//g; s/\n/\\n/g'
}

json_ok() {
  printf 'Content-Type: application/json\r\nCache-Control: no-store\r\n\r\n%s\n' "$1"
}

json_status() {
  status_code="$1"
  status_reason="$2"
  body="$3"
  printf 'Status: %s %s\r\nContent-Type: application/json\r\nCache-Control: no-store\r\n\r\n%s\n' "$status_code" "$status_reason" "$body"
}
