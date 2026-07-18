param(
  [Parameter(Mandatory = $true)]
  [string]$WakeAt,
  [Parameter(Mandatory = $true)]
  [string]$NotifyUrl
)

$ErrorActionPreference = "Stop"
$wakeTime = [DateTimeOffset]::Parse($WakeAt).ToUniversalTime()
if ($wakeTime -le [DateTimeOffset]::UtcNow.AddSeconds(1)) {
  throw "WakeAt must be in the future"
}

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class GechoWaitableTimer {
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern IntPtr CreateWaitableTimer(IntPtr attributes, bool manualReset, string name);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool SetWaitableTimer(IntPtr timer, ref long dueTime, int period, IntPtr completionRoutine, IntPtr argToCompletionRoutine, bool resume);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool CloseHandle(IntPtr handle);
}
"@

$timer = [GechoWaitableTimer]::CreateWaitableTimer([IntPtr]::Zero, $true, $null)
if ($timer -eq [IntPtr]::Zero) {
  throw "CreateWaitableTimer failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
}

try {
  # Absolute UTC FILETIME. The final true asks Windows to resume from a
  # suspended power-saving state when this timer becomes signaled.
  [long]$dueTime = $wakeTime.UtcDateTime.ToFileTimeUtc()
  if (-not [GechoWaitableTimer]::SetWaitableTimer($timer, [ref]$dueTime, 0, [IntPtr]::Zero, [IntPtr]::Zero, $true)) {
    throw "SetWaitableTimer failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
  }
  $waitResult = [GechoWaitableTimer]::WaitForSingleObject($timer, [uint32]4294967295)
  if ($waitResult -ne 0) {
    throw "WaitForSingleObject failed: $waitResult"
  }
  try {
    Invoke-WebRequest -UseBasicParsing -Method Post -Uri $NotifyUrl -TimeoutSec 10 | Out-Null
  } catch {
    # The Bridge may still be resuming; the Node scheduler will independently
    # dispatch the due job when it resumes.
  }
} finally {
  [void][GechoWaitableTimer]::CloseHandle($timer)
}
