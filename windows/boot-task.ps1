# Run via start-at-boot.bat (needs admin). Makes the investment tracker start when Windows boots,
# before anyone signs in (same approach as doorbell-monitor):
#  - a scheduled task "Investment tracker" running windows\start-hit.bat as SYSTEM at startup
#  - a Windows Firewall rule allowing inbound TCP 3001 on the Private profile only
#  - then (re)starts the server through the task
# Remove everything again with:  powershell -ExecutionPolicy Bypass -File windows\boot-task.ps1 -Remove
param([switch]$Remove)
$ErrorActionPreference = 'Stop'
$App = Split-Path -Parent $PSScriptRoot
$Name = 'Investment tracker'
$Rule = 'Investment tracker (TCP 3001, Private)'
$Bat = Join-Path $App 'windows\start-hit.bat'

function Ok($m) { Write-Host "  [OK] $m" -ForegroundColor Green }

function Stop-Tracker {
  if (Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
  }
  Get-CimInstance Win32_Process |
    Where-Object { ($_.Name -eq 'node.exe' -and $_.CommandLine -match 'docker[\\/]server\.ts') -or
                   ($_.Name -eq 'cmd.exe' -and $_.CommandLine -match 'start-hit\.bat') } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

if ($Remove) {
  Stop-Tracker
  if (Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $Name -Confirm:$false; Ok "Removed task '$Name'"
  }
  Get-NetFirewallRule -DisplayName $Rule -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  Ok 'Removed firewall rule'
  exit 0
}

Write-Host "`n== Start the investment tracker at boot, without signing in"
$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c `"$Bat`"" -WorkingDirectory $App
$trigger = New-ScheduledTaskTrigger -AtStartup
$trigger.Delay = 'PT30S'
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -StartWhenAvailable -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $Name -Action $action -Trigger $trigger -Principal $principal `
  -Settings $settings -Description 'Household Investment Tracker web server on port 3001. Logs: logs\hit.log in the app folder.' -Force | Out-Null
Ok "Task '$Name' runs at every boot as SYSTEM"

Get-NetFirewallRule -DisplayName $Rule -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName $Rule -Direction Inbound -Protocol TCP -LocalPort 3001 `
  -Action Allow -Profile Private | Out-Null
Ok 'Firewall: inbound TCP 3001 allowed on Private networks only'

Stop-Tracker
Start-ScheduledTask -TaskName $Name
Start-Sleep 15
try {
  $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 10 http://localhost:3001
  Ok "Tracker answering at http://localhost:3001 (HTTP $($r.StatusCode))"
} catch {
  Write-Host '  [X]  Tracker did not answer; see logs\hit.log and Task Scheduler > Investment tracker' -ForegroundColor Red
  exit 1
}
