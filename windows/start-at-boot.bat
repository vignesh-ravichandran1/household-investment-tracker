@echo off
rem Makes the investment tracker start when Windows boots, without anyone signing in (asks for admin).
rem Also opens TCP 3001 in Windows Firewall for Private networks only. Run again any time to restart it.
net session >nul 2>&1
if %errorlevel% neq 0 (
  powershell -NoProfile -Command "Start-Process '%~f0' -Verb RunAs"
  exit /b
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0boot-task.ps1"
echo.
pause
