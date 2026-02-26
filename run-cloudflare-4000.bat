@echo off
title iCxiFi - Cloudflare Tunnel 4000

REM Find cloudflared (PATH, common install locations, or same folder as this bat)
set "CFD="
where cloudflared >nul 2>&1 && set "CFD=cloudflared"
if not defined CFD if exist "C:\Program Files (x86)\cloudflared\cloudflared.exe" set "CFD=C:\Program Files (x86)\cloudflared\cloudflared.exe"
if not defined CFD if exist "C:\cloudflared\cloudflared.exe" set "CFD=C:\cloudflared\cloudflared.exe"
if not defined CFD if exist "%~dp0cloudflared.exe" set "CFD=%~dp0cloudflared.exe"

if not defined CFD (
  echo cloudflared not found.
  echo.
  echo Install from https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation/
  echo Or: winget install Cloudflare.cloudflared
  echo.
  echo Then either add to PATH, or place cloudflared.exe in this folder.
  echo.
  pause
  exit /b 1
)

echo Starting Cloudflare tunnel for http://localhost:4000...
echo Ensure the API is running on port 4000 ^(npm run dev in api folder^).
echo.
echo Copy the trycloudflare.com URL and set on router:
echo   echo "https://YOUR-URL.trycloudflare.com" ^> /etc/icxifi/cloud_base_url
echo.
start "cloudflare" powershell -NoExit -Command "& '%CFD%' tunnel --url http://localhost:4000"
