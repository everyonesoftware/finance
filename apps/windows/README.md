# Finance for Windows

Native WinUI 3 client for the existing Finance server. The sign-in screen accepts the server's HTTPS origin, username and password. HTTP is allowed only for loopback development. Requests do not follow redirects; the server session cookie stays in memory and is discarded on exit. Only the last successful origin and username are saved in `%LOCALAPPDATA%\EveryoneSoftware\Finance\connection.json`.

The app covers Overview (balances, history and recent transactions), Accounts and account details (including latest brokerage holdings), searchable Transactions, Real Estate estimate history, and Settings with server sign-out. Manual accounts can import UTF-8 CSV, OFX and QFX exports through a server preview and explicit confirmation. CSV supports standard headers with date and signed-amount options. Account/property management, custom column mapping, batch import and investment snapshot writes remain in the web app. No bank sign-in, demo ledger or updater feed is built in.

## Build and launch on Windows

From the repository root on an x64 Windows desktop with .NET 10 SDK:

```powershell
dotnet publish apps/windows/Finance.App/Finance.App.csproj -c Release -o apps/windows/artifacts/publish
powershell.exe -NoProfile -File apps/windows/validation/Check-WinUI.ps1 -PublishDirectory apps/windows/artifacts/publish
```

The published folder is self-contained. Run `Finance.exe` in that folder; keep its resources and DLLs beside it. The launch check validates the generated resource index and the visible signed-out UI, not signed-in behavior. On a disposable server, exercise invalid/retried login, each navigation route, transaction search, file picker cancellation, invalid and duplicate import previews, dismissal without writes, confirmation with account readback, actual sign-out and reopening without a saved cookie. Check native keyboard navigation and title-bar behavior at multiple DPI settings.

For visual acceptance, check the signed-in views in Windows light, dark and contrast themes. Resize Overview from side-by-side cards to a stacked layout; try empty, single-day and multi-day history. In Transactions, verify search, keyboard scrolling, and right-aligned amounts with long descriptions in a narrow window. In Settings, verify the shared Windows Common panel shows the installed version and that checking for updates is unavailable without a configured backend.

## Release packaging

`scripts/build-finance-windows.ps1` is the Windows build entrypoint. It requires native x64 Windows, .NET 10, PowerShell 7.4+, and an unlocked interactive desktop on a disposable runner with no existing Finance installation or profile. It uses Velopack **1.2.161** for both the CLI and the app’s installer hooks. The package ID is `EveryoneSoftware.Finance`; the application executable is `Finance.exe`, and the channel and runtime are both `win-x64`. The Finance app does not yet discover or apply updates in-app.

From a clean checkout on a disposable Windows VM:

```powershell
$env:RELEASE_VERSION = '0.1.1' # CI supplies 0.1.<run number>
$env:GITHUB_SHA = git rev-parse HEAD
$env:RELEASE_ARTIFACT_DIR = 'dist/native/windows' # new or empty
./scripts/build-finance-windows.ps1 -DisposableDesktop
```

The hosted caller supplies the same environment variables and does not need `-DisposableDesktop`. The script tests the source contracts, publishes a self-contained WinUI and .NET payload with exact version and source metadata, and verifies that the full package contains the published files byte for byte. Its five-minute installer smoke runs the staged Setup, compares the installed full package with the artifact, checks uninstall registration and the Start menu shortcut, captures the responding installed window, and verifies supported uninstall removed the installation. Logs, screenshot and a JSON verdict go to `<artifact-directory>-smoke`, outside the publishable assets. If the runner has no usable desktop or the smoke fails, the artifact directory is not populated. Use a new output path for a retry so earlier evidence is retained.

After a successful smoke, the output contains only these three files:

- `Finance-windows-x64-<version>-Setup.exe` — unsigned per-user installer; Windows may display a warning.
- `EveryoneSoftware.Finance-<version>-win-x64-full.nupkg` — full package, with the filename and bytes emitted by Velopack.
- `releases.win-x64.json` — Velopack feed, unchanged; its size and SHA-1/SHA-256 fields are checked against the full package.

This build script does not publish, code-sign, or produce release-level checksums and metadata. Installer smoke does not verify signed-in functionality or upgrades.

## Validation from Linux/WSL

```sh
node --test apps/windows/validation/contracts.mjs
pwsh -NoProfile -File apps/windows/validation/Check-WinUI.ps1
pwsh -NoProfile -File apps/windows/validation/Test-ReleasePackage.ps1
node apps/windows/validation/real-server.mjs
dotnet build apps/windows/Finance.App/Finance.App.csproj -c Release \
  -p:WindowsAppSDKSelfContained=false -p:SelfContained=false -p:OutputType=Library \
  -p:PrepareForRunDependsOn=CopyFilesToOutputDirectory
```

Use `npm ci` at the repository root for the HTTP integration harness. If this Linux host lacks ICU, export `DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1` before the checks. The HTTP check launches the standalone Finance server with a temporary SQLite database and exercises the actual Windows API client. Neither that check nor the compile-only target establishes native launch or production packaging.
