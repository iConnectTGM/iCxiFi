# iCxiFi API Test Script (PowerShell)
# Run: cd D:\iCxiFi\api; .\test-api.ps1
# With custom router: .\test-api.ps1 -Rid "00-00-00-00-00-01" -ApiKey "3a5b123d4e5f6g7h"

param(
  [string]$Base = "http://localhost:4000",
  [string]$Rid = "10:82:3d:54:6e:fe",
  [string]$ApiKey = "rk_live_mysinglekey123"
)

$headers = @{
  "Authorization" = "Bearer $ApiKey"
  "X-Router-ID"   = $Rid
  "Content-Type"  = "application/json"
}

Write-Host "Testing iCxiFi API" -ForegroundColor Cyan
Write-Host "BASE=$Base RID=$Rid" -ForegroundColor Gray
Write-Host ""

# 0. Health
Write-Host "0. GET /api/health" -ForegroundColor Yellow
try {
  $health = Invoke-RestMethod -Uri "$Base/api/health"
  Write-Host "   OK: db=$($health.db) uptime=$($health.uptimeSec)s" -ForegroundColor Green
} catch {
  Write-Host "   FAIL: $_" -ForegroundColor Red
  exit 1
}

# 1. Config
Write-Host "1. GET /api/router/config" -ForegroundColor Yellow
try {
  $config = Invoke-RestMethod -Uri "$Base/api/router/config" -Headers $headers
  Write-Host "   OK: routerId=$($config.routerId)" -ForegroundColor Green
} catch {
  Write-Host "   FAIL: $_" -ForegroundColor Red
  exit 1
}

# 2. Create voucher
Write-Host "2. POST /api/router/vouchers/create" -ForegroundColor Yellow
try {
  $body = '{"amount":10,"deviceId":"vendo-1"}'
  $create = Invoke-RestMethod -Uri "$Base/api/router/vouchers/create" -Method Post -Headers $headers -Body $body
  $code = $create.voucher.code
  Write-Host "   OK: code=$code" -ForegroundColor Green
} catch {
  Write-Host "   FAIL: $_" -ForegroundColor Red
  exit 1
}

# 3. Redeem voucher
Write-Host "3. POST /api/router/vouchers/redeem" -ForegroundColor Yellow
try {
  $redeemBody = @{ code = $code; client = @{ ip = "172.22.0.104"; mac = "AA:BB:CC:DD:EE:FF" } } | ConvertTo-Json
  $redeem = Invoke-RestMethod -Uri "$Base/api/router/vouchers/redeem" -Method Post -Headers $headers -Body $redeemBody
  Write-Host "   OK: grant=$($redeem.grant.minutes) min" -ForegroundColor Green
} catch {
  Write-Host "   FAIL: $_" -ForegroundColor Red
}

# 4. Summary (note: query param ?range=today, not /range/today)
Write-Host "4. GET /api/router/reports/summary?range=today" -ForegroundColor Yellow
try {
  $summary = Invoke-RestMethod -Uri "$Base/api/router/reports/summary?range=today" -Headers $headers
  Write-Host "   OK: totalAmount=$($summary.totalAmount) totalVouchers=$($summary.totalVouchers)" -ForegroundColor Green
} catch {
  Write-Host "   FAIL: $_" -ForegroundColor Red
}

Write-Host ""
Write-Host "Done." -ForegroundColor Cyan
