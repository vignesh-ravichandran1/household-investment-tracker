@echo off
rem Starts the Household Investment Tracker web server and restarts it if it ever stops.
rem Run at boot by the "Investment tracker" task (see start-at-boot.bat); you can also double-click it.
rem Data lives in E:\HIT-data (database.json + backups\). Back that folder up.
cd /d "%~dp0.."
set HOST=0.0.0.0
set PORT=3001
set HIT_DATA_DIR=E:\HIT-data
set ALLOWED_ORIGIN=private
if not exist logs mkdir logs
:loop
echo [%date% %time%] Starting investment tracker on port %PORT%... >> logs\hit.log
node node_modules\tsx\dist\cli.mjs docker\server.ts >> logs\hit.log 2>&1
echo [%date% %time%] Stopped (exit %errorlevel%). Restarting in 10 seconds. >> logs\hit.log
ping -n 11 127.0.0.1 >nul
goto loop
