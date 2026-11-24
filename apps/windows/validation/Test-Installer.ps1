#Requires -Version 7.4
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$InstallerPath,
    [Parameter(Mandatory)][string]$PackagePath,
    [Parameter(Mandatory)][string]$EvidenceDirectory,
    [switch]$DisposableDesktop
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$evidence = [IO.Path]::GetFullPath($EvidenceDirectory)
$null = New-Item -Path $evidence -ItemType Directory # don't overwrite any existing evidence
$summary = [ordered]@{ status = 'failed'; installerSha256 = $null; packageSha256 = $null; installRoot = $null
    installVerified = $false; windowVerified = $false; uninstallVerified = $false; failure = $null; cleanupErrors = @() }
$clock = [Diagnostics.Stopwatch]::StartNew()
$root = $null
$app = $null
$mutation = $false
$uninstallStarted = $false
$id = 'EveryoneSoftware.Finance'
$key = "Software\Microsoft\Windows\CurrentVersion\Uninstall\$id"

function Save-Json($Value, [string]$Name) {
    ConvertTo-Json -InputObject $Value -Depth 5 | Set-Content -LiteralPath (Join-Path $evidence $Name)
}
function Get-Registration {
    foreach ($hive in 'CurrentUser', 'LocalMachine') {
        foreach ($view in 'Registry64', 'Registry32') {
            $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey($hive, $view)
            try {
                $entry = $base.OpenSubKey($key)
                if ($entry) {
                    try { [pscustomobject]@{ hive = $hive; view = $view; location = $entry.GetValue('InstallLocation'); version = $entry.GetValue('DisplayVersion') } }
                    finally { $entry.Dispose() }
                }
            } finally { $base.Dispose() }
        }
    }
}
function Get-Shortcuts {
    $shell = New-Object -ComObject WScript.Shell
    try {
        foreach ($folder in 'StartMenu', 'CommonStartMenu', 'DesktopDirectory', 'CommonDesktopDirectory') {
            $path = [Environment]::GetFolderPath($folder)
            if (-not $path -or -not (Test-Path -LiteralPath $path)) { continue }
            foreach ($file in Get-ChildItem -LiteralPath $path -Filter '*.lnk' -Recurse -File) {
                $link = $shell.CreateShortcut($file.FullName)
                try {
                    if ($file.BaseName -in @('Finance', $id) -or $link.TargetPath.StartsWith("$root\", [StringComparison]::OrdinalIgnoreCase)) {
                        [pscustomobject]@{ folder = $folder; path = $file.FullName; target = $link.TargetPath }
                    }
                } finally { $null = [Runtime.InteropServices.Marshal]::FinalReleaseComObject($link) }
            }
        }
    } finally { $null = [Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) }
}
function Get-OwnedProcesses {
    Get-CimInstance Win32_Process -OperationTimeoutSec 5 | Where-Object {
        $_.ExecutablePath -and $_.ExecutablePath.StartsWith("$root\", [StringComparison]::OrdinalIgnoreCase)
    } | Select-Object ProcessId, ExecutablePath
}
function Invoke-InstallerProcess([string]$Executable, [string[]]$Arguments, [string]$Label, [int]$TimeoutSeconds) {
    $info = [Diagnostics.ProcessStartInfo]::new($Executable)
    $info.WorkingDirectory = $evidence
    $info.UseShellExecute = $false
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    foreach ($arg in ($Arguments + @('--log', (Join-Path $evidence "$Label.log")))) { $info.ArgumentList.Add($arg) }
    $process = [Diagnostics.Process]::Start($info)
    try {
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
            $process.Kill($true)
            $null = $process.WaitForExit(5000)
            throw "$Label timed out after ${TimeoutSeconds}s."
        }
        if (-not $stdout.Wait(3000) -or -not $stderr.Wait(3000)) { throw "$Label left open log streams." }
        $stdout.Result | Set-Content -LiteralPath (Join-Path $evidence "$Label-stdout.txt")
        $stderr.Result | Set-Content -LiteralPath (Join-Path $evidence "$Label-stderr.txt")
        if ($process.ExitCode -ne 0) { throw "$Label exited with code $($process.ExitCode)." }
    } finally { $process.Dispose() }
}

try {
    if (-not $IsWindows) { throw 'Installer acceptance requires native Windows, not Linux/WSL.' }
    if (-not $DisposableDesktop -and -not ($env:GITHUB_ACTIONS -eq 'true' -and $env:RUNNER_ENVIRONMENT -eq 'github-hosted')) {
        throw 'Run only on a disposable Windows desktop; use -DisposableDesktop to acknowledge a disposable VM.'
    }
    if (-not [Environment]::UserInteractive -or (Get-Process -Id $PID).SessionId -eq 0) { throw 'An interactive Windows desktop is required.' }
    . (Join-Path $PSScriptRoot 'ReleasePackage.ps1')
    $installer = (Resolve-Path -LiteralPath $InstallerPath).ProviderPath
    $package = (Resolve-Path -LiteralPath $PackagePath).ProviderPath
    Assert-ReleaseFile $installer
    Assert-ReleaseFile $package
    if ([IO.Path]::GetFileName($package) -cnotmatch ('^' + [regex]::Escape($id) + '-(?<version>0\.1\.[1-9][0-9]*)-win-x64-full\.nupkg$')) {
        throw 'PackagePath must name the emitted Finance win-x64 full package.'
    }
    $version = $Matches.version
    if ([IO.Path]::GetFileName($installer) -cne "Finance-windows-x64-$version-Setup.exe") {
        throw 'InstallerPath must name the staged Finance Setup EXE for the same version.'
    }
    $summary.installerSha256 = (Get-FileHash -LiteralPath $installer).Hash
    $summary.packageSha256 = (Get-FileHash -LiteralPath $package).Hash
    $root = Join-Path ([IO.Path]::GetTempPath()) ('Finance-install-smoke-' + [guid]::NewGuid().ToString('N'))
    $summary.installRoot = $root
    $local = [Environment]::GetFolderPath('LocalApplicationData')
    if (-not $local -or (Test-Path -LiteralPath (Join-Path $local 'EveryoneSoftware/Finance')) -or
        (Test-Path -LiteralPath (Join-Path $local $id)) -or (Test-Path -LiteralPath $root) -or
        @(Get-Registration).Count -or @(Get-Shortcuts).Count) { throw 'Finance installation or preferences already exist; refusing to run.' }
    Add-Type -AssemblyName System.Windows.Forms, System.Drawing
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class FinanceInstallerSmoke {
    [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] public static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
    [DllImport("user32.dll")] public static extern bool SwitchDesktop(IntPtr desktop);
    [DllImport("user32.dll")] public static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd, int command);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern IntPtr SendMessageTimeout(IntPtr hwnd, uint msg, IntPtr w, IntPtr l, uint flags, uint timeout, out IntPtr result);
    [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out Rect value, int length);
    public static bool Responds(IntPtr hwnd) => IsWindowVisible(hwnd) && SendMessageTimeout(hwnd, 0, IntPtr.Zero, IntPtr.Zero, 2, 1000, out _) != IntPtr.Zero;
}
'@
    $null = [FinanceInstallerSmoke]::SetThreadDpiAwarenessContext([IntPtr]::new(-4))
    $desktop = [FinanceInstallerSmoke]::OpenInputDesktop(0, $false, 0x0100)
    if ($desktop -eq [IntPtr]::Zero) { throw 'No accessible input desktop.' }
    try { if (-not [FinanceInstallerSmoke]::SwitchDesktop($desktop)) { throw 'The input desktop is locked or not usable.' } }
    finally { $null = [FinanceInstallerSmoke]::CloseDesktop($desktop) }
    $mutation = $true
    Invoke-InstallerProcess $installer @('--silent', '--installto', $root) 'install' 85
    $appExe = Join-Path $root 'current/Finance.exe'
    $update = Join-Path $root 'Update.exe'
    Assert-X64Executable $appExe
    Assert-ReleaseFile $update
    Assert-ReleaseFile (Join-Path $root 'current/resources.pri')
    # The pinned native locator stores the full package locally without the channel suffix.
    $installedPackage = Join-Path $root "packages/$id-$version-full.nupkg"
    Assert-ReleaseFile $installedPackage
    if ((Get-FileHash -LiteralPath $installedPackage).Hash -cne $summary.packageSha256) { throw 'Setup installed a different full package.' }
    $registration = @(Get-Registration)
    $links = @(Get-Shortcuts)
    Save-Json @{ registration = $registration; shortcuts = $links } 'installed.json'
    if (-not $registration.Count -or @($registration | Where-Object {
        $_.hive -ne 'CurrentUser' -or $_.version -cne $version -or ([string]$_.location).TrimEnd('\') -ine $root
    }).Count) {
        throw 'Setup did not register the isolated per-user installation.'
    }
    if (-not @($links | Where-Object { $_.folder -eq 'StartMenu' -and $_.target.StartsWith("$root\", [StringComparison]::OrdinalIgnoreCase) }).Count) {
        throw 'Setup did not create a Start menu shortcut for the isolated installation.'
    }
    $summary.installVerified = $true
    $app = Start-Process -FilePath $appExe -WorkingDirectory (Split-Path $appExe) -PassThru `
        -RedirectStandardOutput (Join-Path $evidence 'app-stdout.txt') -RedirectStandardError (Join-Path $evidence 'app-stderr.txt')
    $deadline = $clock.Elapsed.TotalSeconds + 45
    $samples = 0
    $previous = [IntPtr]::Zero
    do {
        $app.Refresh()
        if ($app.HasExited) { throw "Installed Finance exited before drawing a window: $($app.ExitCode)" }
        $handle = $app.MainWindowHandle
        if ($handle -eq $previous -and $handle -ne [IntPtr]::Zero -and $app.MainWindowTitle -ceq 'Finance' -and [FinanceInstallerSmoke]::Responds($handle)) { $samples++ }
        else { $samples = 0; $previous = $handle }
        if ($samples -ge 3) { break }
        Start-Sleep -Milliseconds 400
    } while ($clock.Elapsed.TotalSeconds -lt $deadline)
    if ($samples -lt 3) { throw 'No stable responsive Finance window on the desktop.' }
    $null = [FinanceInstallerSmoke]::ShowWindow($handle, 3)
    $null = [FinanceInstallerSmoke]::SetForegroundWindow($handle)
    Start-Sleep -Milliseconds 600
    if ([FinanceInstallerSmoke]::GetForegroundWindow() -ne $handle) { throw 'Finance window is not in the foreground.' }
    $bounds = [FinanceInstallerSmoke+Rect]::new()
    if ([FinanceInstallerSmoke]::DwmGetWindowAttribute($handle, 9, [ref]$bounds, 16) -ne 0) { throw 'Cannot read visible Finance window bounds.' }
    $width = $bounds.Right - $bounds.Left; $height = $bounds.Bottom - $bounds.Top
    $screen = [Windows.Forms.SystemInformation]::VirtualScreen
    if ($width -lt 100 -or $height -lt 100 -or $bounds.Left -lt $screen.Left -or $bounds.Right -gt $screen.Right -or
        $bounds.Top -lt $screen.Top -or $bounds.Bottom -gt $screen.Bottom) { throw 'Invalid or off-screen Finance window bounds.' }
    $bitmap = [Drawing.Bitmap]::new($width, $height)
    $graphics = [Drawing.Graphics]::FromImage($bitmap)
    try {
        $graphics.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bitmap.Size)
        $bitmap.Save((Join-Path $evidence 'window.png'), [Drawing.Imaging.ImageFormat]::Png)
        $colors = [Collections.Generic.HashSet[int]]::new()
        for ($x = 0; $x -lt $width; $x += 13) {
            for ($y = 0; $y -lt $height; $y += 13) { $null = $colors.Add($bitmap.GetPixel($x, $y).ToArgb()) }
        }
        if ($colors.Count -lt 8 -or [FinanceInstallerSmoke]::GetForegroundWindow() -ne $handle -or
            -not [FinanceInstallerSmoke]::Responds($handle)) { throw 'Finance window capture was blank, obscured, or unresponsive.' }
    } finally { $graphics.Dispose(); $bitmap.Dispose() }
    Save-Json @{ pid = $app.Id; handle = $handle.ToInt64(); width = $width; height = $height; responsiveSamples = $samples } 'window.json'
    $summary.windowVerified = $true
    if (-not $app.CloseMainWindow() -or -not $app.WaitForExit(10000) -or $app.ExitCode -ne 0) { throw 'Finance did not close cleanly.' }
    $uninstallStarted = $true
    Invoke-InstallerProcess $update @('--uninstall', '--silent') 'uninstall' 35
    $deadline = $clock.Elapsed.TotalSeconds + 35
    do {
        $files = @(if (Test-Path -LiteralPath $root) { Get-ChildItem -LiteralPath $root -Recurse -Force -File | Select-Object -ExpandProperty FullName })
        $remaining = @{ files = $files; registry = @(Get-Registration); shortcuts = @(Get-Shortcuts); processes = @(Get-OwnedProcesses) }
        if (-not $files.Count -and -not $remaining.registry.Count -and -not $remaining.shortcuts.Count -and -not $remaining.processes.Count) { break }
        Start-Sleep -Milliseconds 500
    } while ($clock.Elapsed.TotalSeconds -lt $deadline)
    Save-Json $remaining 'uninstall-remaining.json'
    if ($files.Count -or $remaining.registry.Count -or $remaining.shortcuts.Count -or $remaining.processes.Count) { throw 'Uninstall left installed files, processes, shortcuts, or registration.' }
    $summary.uninstallVerified = $true
    $summary.status = 'passed'
} catch {
    $summary.failure = $_.ToString()
    ($_ | Format-List * -Force | Out-String) | Set-Content -LiteralPath (Join-Path $evidence 'failure.txt')
    throw
} finally {
    if ($app) {
        try { if (-not $app.HasExited) { $app.Kill($true); $null = $app.WaitForExit(5000) } }
        catch { $summary.cleanupErrors += $_.ToString() }
        finally { $app.Dispose() }
    }
    if ($mutation -and $summary.status -ne 'passed') {
        # Only retry the supported uninstall once, and only with an owned registration.
        try {
            Save-Json @(Get-OwnedProcesses) 'failure-processes.json'
            $owned = @(Get-Registration | Where-Object { $_.hive -eq 'CurrentUser' -and ([string]$_.location).TrimEnd('\') -ieq $root })
            $update = Join-Path $root 'Update.exe'
            if (-not $uninstallStarted -and $owned.Count -and (Test-Path -LiteralPath $update -PathType Leaf)) {
                Invoke-InstallerProcess $update @('--uninstall', '--silent') 'cleanup-uninstall' 20
            }
        } catch { $summary.cleanupErrors += $_.ToString() }
    }
    $summary.seconds = $clock.Elapsed.TotalSeconds
    Save-Json $summary 'summary.json'
}
Write-Host "Installer lifecycle passed; evidence: $evidence"
