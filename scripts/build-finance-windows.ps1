#Requires -Version 7.4
[CmdletBinding()]
param([switch]$DisposableDesktop)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$version = $env:RELEASE_VERSION
$sha = $env:GITHUB_SHA
if ($version -cnotmatch '^0\.1\.[1-9][0-9]*$') { throw 'RELEASE_VERSION must be a canonical 0.1.<positive count>.' }
if ($sha -cnotmatch '^[0-9a-f]{40}$') { throw 'GITHUB_SHA must be a full lowercase Git commit SHA.' }
if (-not $env:RELEASE_ARTIFACT_DIR) { throw 'RELEASE_ARTIFACT_DIR is required.' }
if (-not $IsWindows -or [Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne 'X64') {
    throw 'Finance release packaging requires native x64 Windows.'
}
if (-not $DisposableDesktop -and -not ($env:GITHUB_ACTIONS -eq 'true' -and $env:RUNNER_ENVIRONMENT -eq 'github-hosted')) {
    throw 'Use a GitHub-hosted runner or explicitly acknowledge a disposable VM with -DisposableDesktop.'
}

function Invoke-Checked([string]$Executable, [string[]]$Arguments) {
    & $Executable @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Executable exited with code $LASTEXITCODE ($($Arguments[0]))." }
}

$repo = Split-Path -Parent $PSScriptRoot
$windows = Join-Path $repo 'apps/windows'
$validation = Join-Path $windows 'validation'
. (Join-Path $validation 'ReleasePackage.ps1')
$artifact = [IO.Path]::GetFullPath($env:RELEASE_ARTIFACT_DIR, $repo).TrimEnd('\', '/')
$evidence = "$artifact-smoke"
$stage = $null
$scratch = $null
Push-Location $repo
try {
    $head = Invoke-Checked git @('rev-parse', 'HEAD')
    if ($head -cne $sha) { throw 'GITHUB_SHA must match the checked-out commit.' }
    $dirty = @(Invoke-Checked git @('status', '--porcelain', '--untracked-files=all', '--',
            'apps/windows', 'public/icons/finance-192.png', 'scripts/build-finance-windows.ps1'))
    if ($dirty.Count) { throw "Windows release inputs are not clean at ${sha}:`n$($dirty -join "`n")" }
    if (Test-Path -LiteralPath $artifact) {
        $item = Get-Item -LiteralPath $artifact -Force
        if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
            @(Get-ChildItem -LiteralPath $artifact -Force).Count) { throw 'RELEASE_ARTIFACT_DIR must be new or an empty real directory.' }
    }
    if (Test-Path -LiteralPath $evidence) { throw "Refusing to overwrite smoke evidence: $evidence" }

    & (Join-Path $validation 'Check-WinUI.ps1')
    & (Join-Path $validation 'Test-ReleasePackage.ps1')
    Invoke-Checked dotnet @('run', '--project', (Join-Path $validation 'ApiChecks.csproj'), '-c', 'Release')
    Invoke-Checked dotnet @('run', '--project', (Join-Path $validation 'UpdateChecks.csproj'), '-c', 'Release')
    Invoke-Checked dotnet @('run', '--project', (Join-Path $validation 'UpdateFlowChecks.csproj'), '-c', 'Release')

    $scratch = [IO.Directory]::CreateTempSubdirectory('finance-release-').FullName
    $publish = Join-Path $scratch 'publish'
    $releases = Join-Path $scratch 'releases'
    Push-Location $windows
    try {
        Invoke-Checked dotnet @('tool', 'restore', '--tool-manifest', (Join-Path $windows '.config/dotnet-tools.json'))
        Invoke-Checked dotnet @('publish', (Join-Path $windows 'Finance.App/Finance.App.csproj'), '-c', 'Release', '-r', 'win-x64',
            '--self-contained', 'true', '-p:WindowsAppSDKSelfContained=true', '-p:ContinuousIntegrationBuild=true',
            "-p:Version=$version", "-p:InformationalVersion=$version+$sha", '-p:IncludeSourceRevisionInInformationalVersion=false', '-o', $publish)
        Assert-FinancePublish $publish $version $sha
        Invoke-Checked dotnet @('tool', 'run', 'vpk', '--', 'pack', '--packId', 'EveryoneSoftware.Finance', '--packVersion', $version,
            '--packDir', $publish, '--mainExe', 'Finance.exe', '--packTitle', 'Finance', '--packAuthors', 'Everyone Software',
            '--runtime', 'win-x64', '--channel', 'win-x64', '--framework', 'vcredist143-x64', '--shortcuts', 'StartMenuRoot',
            '--delta', 'None', '--noPortable', '--outputDir', $releases, '--yes', '--skip-updates', '--noDefaultExclude', '--exclude', '(?!)')
    } finally { Pop-Location }
    Assert-FinancePackage $publish $releases $version

    # Only a successful smoke can promote this isolated staging directory into the CI artifact path.
    $stage = "$artifact-staging-$([guid]::NewGuid().ToString('N'))"
    $null = [IO.Directory]::CreateDirectory($stage)
    $setup = Join-Path $stage "Finance-windows-x64-$version-Setup.exe"
    $packageName = "EveryoneSoftware.Finance-$version-win-x64-full.nupkg"
    $package = Join-Path $stage $packageName
    $feed = 'releases.win-x64.json'
    $rawSetup = Join-Path $releases 'EveryoneSoftware.Finance-win-x64-Setup.exe'
    Assert-ReleaseFile $rawSetup
    if ((Get-AuthenticodeSignature -LiteralPath $rawSetup).Status -ne 'NotSigned') { throw 'Expected the unsigned Finance Setup EXE.' }
    [IO.File]::Copy($rawSetup, $setup)
    foreach ($name in $packageName, $feed) { [IO.File]::Copy((Join-Path $releases $name), (Join-Path $stage $name)) }

    $info = [Diagnostics.ProcessStartInfo]::new((Join-Path $PSHOME 'pwsh.exe'))
    $info.UseShellExecute = $false
    $info.WorkingDirectory = $repo
    foreach ($arg in @('-NoProfile', '-NonInteractive', '-File', (Join-Path $validation 'Test-Installer.ps1'),
            '-InstallerPath', $setup, '-PackagePath', $package, '-EvidenceDirectory', $evidence)) { $info.ArgumentList.Add($arg) }
    if ($DisposableDesktop) { $info.ArgumentList.Add('-DisposableDesktop') }
    Write-Host "Installer smoke evidence (not a release asset): $evidence"
    $smoke = [Diagnostics.Process]::Start($info)
    try {
        if (-not $smoke.WaitForExit(300000)) {
            $smoke.Kill($true)
            $null = $smoke.WaitForExit(5000)
            throw "Installer smoke exceeded five minutes. See $evidence."
        }
        if ($smoke.ExitCode -ne 0) { throw "Installer smoke failed (exit $($smoke.ExitCode)). See $evidence." }
    } finally { $smoke.Dispose() }
    $result = Get-Content -LiteralPath (Join-Path $evidence 'summary.json') -Raw | ConvertFrom-Json -AsHashtable
    if ($result.status -cne 'passed' -or -not $result.installVerified -or -not $result.windowVerified -or -not $result.uninstallVerified -or
        $result.installerSha256 -cne (Get-FileHash -LiteralPath $setup).Hash -or $result.packageSha256 -cne (Get-FileHash -LiteralPath $package).Hash) {
        throw 'Smoke evidence does not confirm the staged installer and full package.'
    }
    if (Test-Path -LiteralPath $artifact) { [IO.Directory]::Delete($artifact) } # never remove an occupied destination
    [IO.Directory]::Move($stage, $artifact)
    $stage = $null
    Write-Host "Staged three unsigned Finance $version assets from $sha at $artifact."
} finally {
    Pop-Location
    foreach ($path in $stage, $scratch) {
        if ($path -and (Test-Path -LiteralPath $path)) { Remove-Item -LiteralPath $path -Recurse -Force }
    }
}
