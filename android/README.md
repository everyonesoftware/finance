# Finance for Android

Native Kotlin / Jetpack Compose client for the self-hosted Finance server. Android 8.0+ (API 26). At launch, enter the server's HTTPS origin (no path), Finance username, and password. The server origin and username are remembered; passwords, authenticated cookies, ledger data, and import drafts are never written to app storage. Sign in again after the app process exits.

- **Overview:** server-calculated net worth and recent balance history.
- **Accounts:** saved account balances, transaction activity, and summaries of investment valuations.
- **Transactions:** search across the returned server ledger by description, date, account name, pending status, or displayed amount. Responses above 24 MiB fail explicitly rather than showing a partial or empty ledger.
- **Property:** saved property addresses and latest estimates.
- **Import:** on an eligible account, select a single CSV, OFX, or QFX document, review the server's preview and balance impact, then confirm. CSV uses server autodetection; custom mapping, batch imports, account/valuation/property editing, and web-specific transaction grouping are not part of this client.
- **Settings:** connection, sign-out, and installed version. No in-app update feed, bank sign-in, or new data aggregator is configured.

## Build and verify

Use JDK 17+ and Android SDK Platform 36. From the repository root:

```sh
(cd android && ./gradlew testDebugUnitTest lintDebug assembleDebug assembleDebugAndroidTest)
npm ci
ANDROID_SERIAL=emulator-5554 FINANCE_TEST_AVD=my-disposable-avd \
  node --import tsx android/verify-live.mjs
```

Replace both emulator identifiers with those of a booted, disposable AVD you own. The live runner installs the debug and test APKs, clears the Finance app on that emulator, and creates a fresh SQLite database and random disposable credentials on an ephemeral loopback port. No live Finance deployment is used. Debug builds permit HTTP only for explicit development loopback addresses; release builds require HTTPS.

The live runner exercises the real Finance routers and database over HTTP with the same Hono Node adapter as the standalone server. It adds request observation for test assertions and an isolated loopback listener.

Output: `app/build/outputs/apk/debug/app-debug.apk` (debug signed, not a release).

## Stage an APK for CI

`bash scripts/build-finance-android.sh` uses the pinned Gradle wrapper, JDK 21, and Android SDK Platform 36 / Build Tools 36.0.0. It runs debug unit tests and lint in either mode before staging an APK. Set:

- `GITHUB_SHA` to the checkout's full commit SHA.
- `RELEASE_VERSION` to the caller-assigned `0.1.N` (`N` is a canonical integer in `1..2100000000` and becomes the Android version code). Choose a higher `N` for each published Android build.
- `RELEASE_ARTIFACT_DIR` to the staging directory.
- `RELEASE_SIGNING_ENABLED` to `false` for validation (`Finance-android-0.1.N-debug.apk`, a CI run artifact only) or `true` for a signed release candidate (`Finance-android-0.1.N.apk`).

Only a trusted signing job should supply `RELEASE_KEYSTORE_BASE64`, `RELEASE_KEYSTORE_PASSWORD`, `RELEASE_KEY_ALIAS`, and `RELEASE_KEY_PASSWORD`. The caller stages a release only after verifying its package, version, and certificate against the configured keystore alias; missing inputs fail the build instead of falling back to debug signing. The script does not publish, generate checksums, or configure an update feed. Never publish a debug APK or an APK signed with a disposable test key.

Caller preflight tests: `node --test android/tests/release-caller.test.mjs`.
