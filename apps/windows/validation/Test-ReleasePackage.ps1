#Requires -Version 7.4
# Cross-platform validator fixtures; the optional probe consumes genuine vpk output.
param([string]$ProbePublish, [string]$ProbeReleases, [string]$ProbeVersion = '0.1.1')
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'ReleasePackage.ps1')
if ($ProbePublish -and $ProbeReleases) {
    Assert-FinancePackage $ProbePublish $ProbeReleases $ProbeVersion
    Write-Host 'Pinned vpk output matches the Windows package contract.'
    return
}
$root = [IO.Directory]::CreateTempSubdirectory('finance-package-test-').FullName
try {
    $publish = New-Item -ItemType Directory (Join-Path $root 'publish')
    $releases = New-Item -ItemType Directory (Join-Path $root 'releases')
    $null = New-Item -ItemType Directory (Join-Path $publish 'Assets')
    Set-Content -LiteralPath (Join-Path $publish 'Finance.exe') 'fixture exe'
    Set-Content -LiteralPath (Join-Path $publish 'Assets/Finance.png') 'fixture asset'
    $package = Join-Path $releases 'EveryoneSoftware.Finance-0.1.1-win-x64-full.nupkg'
    $feed = Join-Path $releases 'releases.win-x64.json'
    $metadata = '<package><metadata><id>EveryoneSoftware.Finance</id><version>0.1.1</version><channel>win-x64</channel><mainExe>Finance.exe</mainExe><os>win</os><rid>win-x64</rid></metadata></package>'
    function New-Fixture([string]$Fault) {
        if (Test-Path -LiteralPath $package) { Remove-Item -LiteralPath $package }
        $archive = [IO.Compression.ZipFile]::Open($package, 'Create')
        try {
            $files = [ordered]@{
                'EveryoneSoftware.Finance.nuspec' = $(if ($Fault -eq 'identity') { $metadata.Replace('<rid>win-x64', '<rid>win-arm64') } else { $metadata })
                'lib/app/Finance.exe' = [IO.File]::ReadAllText((Join-Path $publish 'Finance.exe'))
                'lib/app/Assets/Finance.png' = [IO.File]::ReadAllText((Join-Path $publish 'Assets/Finance.png'))
                'lib/app/Squirrel.exe' = 'fixture updater'
                'lib/app/Finance_ExecutionStub.exe' = 'fixture stub'
                'lib/app/sq.version' = 'fixture version'
            }
            switch ($Fault) {
                missing { $files.Remove('lib/app/Assets/Finance.png') }
                changed { $files['lib/app/Assets/Finance.png'] = 'changed' }
                extra { $files['lib/app/Assets/Squirrel.exe'] = 'unexpected' }
                traversal { $files['lib/app/../Finance.exe'] = 'unsafe' }
                missingStub { $files.Remove('lib/app/Finance_ExecutionStub.exe') }
            }
            foreach ($entry in $files.GetEnumerator()) {
                $writer = [IO.StreamWriter]::new($archive.CreateEntry($entry.Key).Open())
                try { $writer.Write($entry.Value) } finally { $writer.Dispose() }
            }
            if ($Fault -eq 'collision') { $null = $archive.CreateEntry('lib/app/finance.exe') }
        } finally { $archive.Dispose() }
        @{ Assets = @(@{ PackageId = 'EveryoneSoftware.Finance'; Version = '0.1.1'; Type = 'Full'
            FileName = $(if ($Fault -eq 'filename') { '../EveryoneSoftware.Finance-0.1.1-win-x64-full.nupkg' } else { Split-Path -Leaf $package })
            Size = (Get-Item -LiteralPath $package).Length
            SHA1 = $(if ($Fault -eq 'digest') { '0' * 40 } else { (Get-FileHash -LiteralPath $package -Algorithm SHA1).Hash })
            SHA256 = (Get-FileHash -LiteralPath $package).Hash }) } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $feed
    }
    New-Fixture valid
    Assert-FinancePackage $publish $releases '0.1.1'
    foreach ($case in @{
        identity = 'metadata'; missing = 'Missing packaged'; missingStub = 'Missing packaged'; changed = 'byte mismatch'; extra = 'Unexpected packaged'
        traversal = 'Unsafe'; collision = 'colliding'; digest = 'SHA1'; filename = 'feed asset'
    }.GetEnumerator()) {
        New-Fixture $case.Key
        $failure = $null
        try { Assert-FinancePackage $publish $releases '0.1.1' } catch { $failure = $_ }
        if (-not $failure -or $failure.Exception.Message -notlike "*$($case.Value)*") {
            throw "Fixture '$($case.Key)' did not fail as expected: $failure"
        }
    }
    Write-Host 'Release package fixtures passed (valid and nine rejected mutations).'
} finally {
    Remove-Item -LiteralPath $root -Recurse -Force
}
