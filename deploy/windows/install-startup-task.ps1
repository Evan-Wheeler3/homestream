# Registers a scheduled task that starts Private Cinema when this computer starts,
# even before anyone logs in. Run from an elevated (Administrator) PowerShell:
#   powershell -ExecutionPolicy Bypass -File deploy\windows\install-startup-task.ps1
# Remove it later with: Unregister-ScheduledTask -TaskName "Private Cinema"
$script = Join-Path $PSScriptRoot 'start-private-cinema.cmd'
$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c `"$script`""
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType S4U -RunLevel Limited
Register-ScheduledTask -TaskName 'Private Cinema' -Action $action -Trigger $trigger `
  -Settings $settings -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName 'Private Cinema'
Write-Host 'Private Cinema will now start automatically. Log file: deploy\windows\private-cinema.log'
