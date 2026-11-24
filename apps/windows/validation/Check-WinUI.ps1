param([string] $PublishDirectory)

$ErrorActionPreference = 'Stop'
$app = Join-Path $PSScriptRoot '../Finance.App'
[xml] $shell = Get-Content -Raw (Join-Path $app 'Shell.xaml')
[xml] $project = Get-Content -Raw (Join-Path $app 'Finance.App.csproj')
[xml] $manifest = Get-Content -Raw (Join-Path $app 'app.manifest')
$xaml = 'http://schemas.microsoft.com/winfx/2006/xaml'
$controls = @{}
foreach ($element in $shell.SelectNodes('//*')) {
    $name = $element.GetAttribute('Name', $xaml)
    if (!$name) { continue }
    if ($controls.ContainsKey($name)) { throw "Duplicate XAML name: $name" }
    $controls[$name] = $element.LocalName
}
foreach ($source in (Get-ChildItem $app -Filter 'MainWindow*.cs')) {
    foreach ($match in [regex]::Matches((Get-Content $source.FullName -Raw), '\bC<([A-Za-z]+)>\("([A-Za-z]+)"\)')) {
        $type = $match.Groups[1].Value
        $name = $match.Groups[2].Value
        if ($controls[$name] -cne $type) { throw "$name must be a $type in Shell.xaml" }
    }
}
Write-Host "Parsed runtime XAML and checked $($controls.Count) named controls."
if (!$PublishDirectory) { return }
if ($env:OS -ne 'Windows_NT') { throw 'The native launch gate requires Windows PowerShell on an interactive Windows desktop.' }
$directory = (Resolve-Path $PublishDirectory).Path
foreach ($path in 'Finance.exe', 'Finance.dll', 'EveryoneSoftware.WindowsCommon.dll', 'resources.pri', 'Assets/Finance.png') {
    if (!(Test-Path (Join-Path $directory $path) -PathType Leaf)) { throw "Publish payload missing: $path" }
}
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$process = Start-Process (Join-Path $directory 'Finance.exe') -WorkingDirectory $directory -PassThru
try {
    $ready = $false
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    do {
        $process.Refresh()
        if ($process.HasExited) { throw "Finance exited during launch ($($process.ExitCode))." }
        if ($process.MainWindowHandle -ne [IntPtr]::Zero) {
            $window = [System.Windows.Automation.AutomationElement]::FromHandle($process.MainWindowHandle)
            $ready = $window.Current.Name -eq 'Finance'
            foreach ($label in 'Finance server URL', 'Username', 'Password', 'Sign in') {
                $condition = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty, $label)
                $element = $window.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
                $ready = $ready -and $null -ne $element -and !$element.Current.IsOffscreen
            }
        }
        if (!$ready) { Start-Sleep -Milliseconds 200 }
    } until ($ready -or [DateTime]::UtcNow -ge $deadline)
    if (!$ready) { throw 'The Finance window did not expose all visible sign-in controls.' }
    Write-Host 'Native Windows publish launch passed: Finance title and visible sign-in controls.'
} finally {
    if (!$process.HasExited) { Stop-Process -Id $process.Id }
    $process.Dispose()
}
