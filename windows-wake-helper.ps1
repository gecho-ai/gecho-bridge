param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("register", "remove", "status", "guard")]
  [string]$Mode,
  [string]$TaskName,
  [string]$WakeAt,
  [int]$GuardSeconds = 450
)

$ErrorActionPreference = "Stop"

function Write-Result($value) {
  $value | ConvertTo-Json -Compress
}

function Get-PowerShellPath() {
  return (Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe")
}

function Start-WakeGuard() {
  if ($GuardSeconds -lt 30 -or $GuardSeconds -gt 3600) {
    throw "GuardSeconds must be between 30 and 3600"
  }
  Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class GechoPowerRequest {
  [DllImport("kernel32.dll")]
  public static extern uint SetThreadExecutionState(uint flags);
}
"@
  # ES_CONTINUOUS | ES_SYSTEM_REQUIRED. Do not force the display on.
  [void][GechoPowerRequest]::SetThreadExecutionState([uint32]2147483649)
  try {
    Start-Sleep -Seconds $GuardSeconds
  } finally {
    [void][GechoPowerRequest]::SetThreadExecutionState([uint32]2147483648)
  }
}

if ($Mode -eq "guard") {
  Start-WakeGuard
  exit 0
}

if ([string]::IsNullOrWhiteSpace($TaskName) -or $TaskName -notmatch '^GechoBridge-WakeNext-[a-f0-9]{12}$') {
  throw "TaskName is not a valid Gecho wake task name"
}

if ($Mode -eq "remove") {
  $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($null -ne $existing) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  }
  Write-Result @{ removed = ($null -ne $existing); taskName = $TaskName }
  exit 0
}

if ($Mode -eq "status") {
  $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($null -eq $existing) {
    Write-Result @{ exists = $false; taskName = $TaskName }
    exit 0
  }
  $xml = Export-ScheduledTask -TaskName $TaskName
  $info = Get-ScheduledTaskInfo -TaskName $TaskName
  $configuredWakeAt = @($existing.Triggers | ForEach-Object { $_.StartBoundary } | Where-Object { $_ }) | Select-Object -First 1
  Write-Result @{
    exists = $true
    taskName = $TaskName
    wakeToRun = ($xml -match '<WakeToRun>true</WakeToRun>')
    configuredWakeAt = if ($configuredWakeAt) { ([DateTimeOffset]::Parse($configuredWakeAt)).ToString('o') } else { $null }
    nextRunTime = $info.NextRunTime.ToString('o')
    lastRunTime = $info.LastRunTime.ToString('o')
    lastTaskResult = $info.LastTaskResult
  }
  exit 0
}

if ([string]::IsNullOrWhiteSpace($WakeAt)) {
  throw "WakeAt is required when registering a wake task"
}
$wakeTime = [DateTimeOffset]::Parse($WakeAt).LocalDateTime
if ($wakeTime -le (Get-Date).AddSeconds(1)) {
  throw "WakeAt must be in the future"
}

$scriptPath = $PSCommandPath.Replace('"', '""')
$powerShell = Get-PowerShellPath
$arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$scriptPath`" -Mode guard -GuardSeconds $GuardSeconds"
$action = New-ScheduledTaskAction -Execute $powerShell -Argument $arguments
$trigger = New-ScheduledTaskTrigger -Once -At $wakeTime
$settings = New-ScheduledTaskSettingsSet -WakeToRun -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Seconds ($GuardSeconds + 60)) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
$task = New-ScheduledTask -Action $action -Trigger $trigger -Settings $settings -Principal $principal
Register-ScheduledTask -TaskName $TaskName -InputObject $task -Force | Out-Null
Write-Result @{ registered = $true; taskName = $TaskName; wakeAt = ([DateTimeOffset]$wakeTime).ToString('o'); guardSeconds = $GuardSeconds }
