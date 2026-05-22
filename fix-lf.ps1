$paths = @(
  "D:\iCxiFi\router\openwrt\usr\bin\icxifi-opennds-install",
  "D:\iCxiFi\router\openwrt\usr\bin\icxifi-apply-config",
  "D:\iCxiFi\router\openwrt\usr\bin\icxifi-pull-config",
  "D:\iCxiFi\router\openwrt\usr\bin\icxifi-heartbeat",
  "D:\iCxiFi\router\openwrt\usr\bin\icxifi-sync-pending",
  "D:\iCxiFi\router\openwrt\usr\bin\icxifi-replenish-pool",
  "D:\iCxiFi\router\openwrt\usr\bin\icxifi-opennds-finishline",
  "D:\iCxiFi\router\openwrt\usr\bin\icxifi-gen-routerid"
)
Get-ChildItem "D:\iCxiFi\router\openwrt\www\cgi-bin\icxifi\*" -ErrorAction SilentlyContinue | ForEach-Object { $paths += $_.FullName }
$paths += "D:\iCxiFi\router\openwrt\etc\opennds\htdocs\opennds_preauth\icxifi\app.js"
$paths += "D:\iCxiFi\router\openwrt\etc\opennds\htdocs\opennds_preauth\icxifi\index.html"
$paths += "D:\iCxiFi\router\openwrt\etc\opennds\htdocs\opennds_preauth\icxifi\style.css"
foreach ($path in $paths) {
  if (Test-Path $path) {
    $content = [System.IO.File]::ReadAllText($path)
    $content = $content -replace "`r`n", "`n" -replace "`r", ""
    [System.IO.File]::WriteAllText($path, $content)
    Write-Host "LF: $path"
  }
}
