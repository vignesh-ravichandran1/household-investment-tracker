@echo off
rem Sets or changes the investment tracker PIN. Changing it signs every phone/tablet out.
rem The running server picks up the new PIN straight away; no restart needed.
cd /d "%~dp0.."
set HIT_DATA_DIR=E:\HIT-data
node node_modules\tsx\dist\cli.mjs scripts\set-pin.ts
echo.
pause
