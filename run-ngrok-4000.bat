@echo off
title iCxiFi - ngrok 4000

REM Find ngrok (PATH, C:\ngrok, or same folder as this bat)
set "NGROK="
where ngrok >nul 2>&1 && set "NGROK=ngrok"
if not defined NGROK if exist "C:\ngrok\ngrok.exe" set "NGROK=C:\ngrok\ngrok.exe"
if not defined NGROK if exist "%~dp0ngrok.exe" set "NGROK=%~dp0ngrok.exe"
if not defined NGROK if exist "%~dp0api\ngrok.exe" set "NGROK=%~dp0api\ngrok.exe"

if not defined NGROK (
  echo ngrok not found.
  echo.
  echo Install from https://ngrok.com/download
  echo Then either:
  echo   - Add ngrok to PATH, or
  echo   - Place ngrok.exe in C:\ngrok, or
  echo   - Place ngrok.exe in this folder
  echo.
  pause
  exit /b 1
)

echo Starting ngrok http 4000...
echo Ensure the API is running on port 4000 ^(npm run dev in api folder^).
echo.
start "ngrok" powershell -NoExit -Command "& '%NGROK%' http 4000"
