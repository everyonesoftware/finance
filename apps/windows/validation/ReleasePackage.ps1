# Shared release validation. Dot-source from PowerShell 7.4+.
function Assert-ReleaseFile([string]$Path) {
    $file = Get-Item -LiteralPath $Path -ErrorAction Stop
    if ($file -isnot [IO.FileInfo] -or $file.Length -eq 0 -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw "Expected a nonempty regular file: $Path"
    }
}

function Assert-X64Executable([string]$Path) {
    Assert-ReleaseFile $Path
    $reader = [IO.BinaryReader]::new([IO.File]::OpenRead($Path))
    try {
        if ($reader.ReadUInt16() -ne 0x5A4D) { throw "Missing MZ header: $Path" }
        $reader.BaseStream.Position = 0x3c
        $reader.BaseStream.Position = $reader.ReadUInt32()
        if ($reader.ReadUInt32() -ne 0x4550 -or $reader.ReadUInt16() -ne 0x8664) { throw "Expected an x64 PE: $Path" }
    } finally { $reader.Dispose() }
}

function Assert-FinancePublish([string]$Directory, [string]$Version, [string]$SourceSha) {
    foreach ($name in @('Finance.dll', 'Finance.Core.dll', 'Velopack.dll', 'Finance.deps.json', 'Finance.runtimeconfig.json',
        'coreclr.dll', 'hostfxr.dll', 'hostpolicy.dll', 'Microsoft.UI.Xaml.dll', 'Microsoft.WindowsAppRuntime.dll',
        'resources.pri', 'Assets/Finance.png')) {
        Assert-ReleaseFile (Join-Path $Directory $name)
    }
    Assert-X64Executable (Join-Path $Directory 'Finance.exe')
    $assembly = [Diagnostics.FileVersionInfo]::GetVersionInfo((Join-Path $Directory 'Finance.dll'))
    if ($assembly.ProductVersion -cne "$Version+$SourceSha" -or $assembly.FileVersion -cne "$Version.0") {
        throw "Published assembly version/source mismatch: $($assembly.FileVersion), $($assembly.ProductVersion)"
    }
    $runtime = (Get-Content -LiteralPath (Join-Path $Directory 'Finance.runtimeconfig.json') -Raw | ConvertFrom-Json -AsHashtable).runtimeOptions
    $deps = Get-Content -LiteralPath (Join-Path $Directory 'Finance.deps.json') -Raw | ConvertFrom-Json -AsHashtable
    if (-not $runtime.includedFrameworks -or $runtime.Contains('framework') -or $runtime.Contains('frameworks') -or
        $deps.runtimeTarget.name -cnotmatch '/win-x64$') { throw 'Publish must include a self-contained win-x64 runtime.' }
}

function Assert-FinancePackage([string]$PublishDirectory, [string]$ReleaseDirectory, [string]$Version) {
    $id = 'EveryoneSoftware.Finance'
    $packageName = "$id-$Version-win-x64-full.nupkg"
    $package = Join-Path $ReleaseDirectory $packageName
    $feedPath = Join-Path $ReleaseDirectory 'releases.win-x64.json'
    Assert-ReleaseFile $package
    Assert-ReleaseFile $feedPath
    $feed = Get-Content -LiteralPath $feedPath -Raw | ConvertFrom-Json -AsHashtable
    if ($feed.Assets -isnot [array] -or $feed.Assets.Count -ne 1) { throw 'Expected exactly one Velopack feed asset.' }
    $asset = $feed.Assets[0]
    if ($asset.PackageId -cne $id -or $asset.Version -cne $Version -or $asset.Type -cne 'Full' -or
        $asset.FileName -cne $packageName -or $asset.Size -ne (Get-Item -LiteralPath $package).Length) {
        throw 'Velopack feed asset identity or size mismatch.'
    }
    foreach ($algorithm in 'SHA1', 'SHA256') {
        if ($asset[$algorithm] -ine (Get-FileHash -LiteralPath $package -Algorithm $algorithm).Hash) {
            throw "Velopack feed $algorithm mismatch."
        }
    }

    $publish = (Resolve-Path -LiteralPath $PublishDirectory).ProviderPath
    $expected = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($file in Get-ChildItem -LiteralPath $publish -Recurse -Force) {
        if ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Unsupported publish link: $($file.FullName)" }
        if ($file.PSIsContainer) { continue }
        $relative = [IO.Path]::GetRelativePath($publish, $file.FullName).Replace('\', '/')
        $expected.Add("lib/app/$relative", $file.FullName)
    }
    # Exact generated root entries confirmed against vpk 1.2.161 with packTitle Finance.
    foreach ($generated in 'sq.version', 'Squirrel.exe', 'Finance_ExecutionStub.exe') { $expected.Add("lib/app/$generated", '') }
    $envelope = @("$id.nuspec", '[Content_Types].xml', '_rels/.rels')
    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $archive = [IO.Compression.ZipFile]::OpenRead($package)
    try {
        foreach ($entry in $archive.Entries) {
            $name = $entry.FullName
            if ($name -match '(^|/)(\.{1,2}|)(/|$)|[\\:]' -or [IO.Path]::IsPathRooted($name)) { throw "Unsafe ZIP path: $name" }
            if (-not $seen.Add($name)) { throw "Duplicate or case-colliding ZIP path: $name" }
            if ($name -cin $envelope) { continue }
            if (-not $expected.ContainsKey($name)) { throw "Unexpected packaged file: $name" }
            $source = $expected[$name]
            if ($source) {
                $relative = [IO.Path]::GetRelativePath($publish, $source).Replace('\', '/')
                if ($name -cne "lib/app/$relative") { throw "Packaged file casing mismatch: $name" }
                $stream = $entry.Open()
                try { $hash = (Get-FileHash -InputStream $stream -Algorithm SHA256).Hash } finally { $stream.Dispose() }
                if ($hash -cne (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash) { throw "Packaged byte mismatch: $name" }
            } elseif ($name -cnotin @('lib/app/sq.version', 'lib/app/Squirrel.exe', 'lib/app/Finance_ExecutionStub.exe') -or $entry.Length -le 0) {
                throw "Invalid generated package file: $name"
            }
        }
        foreach ($name in $expected.Keys) {
            if (-not $seen.Contains($name)) { throw "Missing packaged file: $name" }
        }
        $nuspec = $archive.GetEntry("$id.nuspec")
        if (-not $nuspec) { throw 'Missing package metadata.' }
        $reader = [IO.StreamReader]::new($nuspec.Open())
        try { [xml]$spec = $reader.ReadToEnd() } finally { $reader.Dispose() }
        foreach ($kv in @{ id = $id; version = $Version; channel = 'win-x64'; mainExe = 'Finance.exe'; os = 'win'; rid = 'win-x64' }.GetEnumerator()) {
            if ($spec.package.metadata.($kv.Key) -cne $kv.Value) { throw "Package metadata mismatch: $($kv.Key)" }
        }
    } finally { $archive.Dispose() }
}
