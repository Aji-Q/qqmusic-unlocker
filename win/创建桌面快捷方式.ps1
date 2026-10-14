# Create a Desktop shortcut for QQMusicUnlocker.exe (double-click once; no admin needed).
# ASCII-only on purpose: Windows PowerShell 5.1 reads .ps1 as ANSI unless it has a
# UTF-8 BOM, so non-ASCII text here would be garbled on some systems.
$ErrorActionPreference = "Stop"
$exe = Join-Path $PSScriptRoot "QQMusicUnlocker.exe"
if (-not (Test-Path $exe)) {
    Write-Host "[ERROR] QQMusicUnlocker.exe not found next to this script." -ForegroundColor Red
    Read-Host "Press Enter to close"
    exit 1
}
$desktop = [Environment]::GetFolderPath("Desktop")
$lnk = Join-Path $desktop "QQMusicUnlocker.lnk"
$ws = New-Object -ComObject WScript.Shell
$sc = $ws.CreateShortcut($lnk)
$sc.TargetPath = $exe
$sc.WorkingDirectory = $PSScriptRoot
$sc.IconLocation = "$exe,0"
$sc.Description = "Decrypt QQ Music .mgg/.mflac files to MP3"
$sc.Save()
Write-Host "[OK] Desktop shortcut created: $lnk" -ForegroundColor Green
Read-Host "Press Enter to close"
