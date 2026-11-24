# Finance

A personal-finance app with a Vite/TypeScript frontend, Hono TypeScript API, Better Auth username/password authentication, SQLite, manual financial accounts, transaction imports, saved bank-account views, and real-estate tracking. Saved financial data is encrypted at rest.

## Downloads

Get the Android and Windows installers and their checksums from [GitHub Releases](https://github.com/everyonesoftware/finance/releases).

[Android](android/README.md) and [Windows](apps/windows/README.md) use the same Finance server as the web app. Use your server's HTTPS URL and existing Finance username and password. The apps browse financial data and import individual transaction files; account and property management remains in the web app. Windows supports in-app updates after a one-time manual install of an updater-enabled release. Android updates still require a manual APK download.

## Requirements

- Node.js 22 or newer
- npm
- Docker with the Compose plugin (for container use)

## Local development

Create a local environment file and generate a unique Better Auth secret:

```powershell
Copy-Item .env.example .env
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

Paste the generated value into `.env` as `BETTER_AUTH_SECRET`. Then install dependencies and start the API and frontend in separate terminals:

```powershell
npm ci
npm run dev:api
```

```powershell
npm run dev
```

The Vite server prints its URL when ready. The API creates the SQLite database and applies migrations at startup using `DATABASE_PATH` from `.env`; `.env.example` stores it under `./data`. The root page provides account creation and username/password login. Registration also asks for an email address, which is stored with the profile. Email verification and email-based password recovery are not configured because no email delivery provider is set up. Authenticated users can update their display name, username, or password in settings.

### Overview and net-worth history

Overview uses the Quiet Ledger layout: a static 365-day trend beside the current total on desktop, stacked above recent transactions and then accounts on phones. The total includes tracked USD account balances minus credit/loan balances; property values and non-USD/unknown-currency accounts are excluded. Coverage notices identify excluded accounts or missing balances instead of treating unavailable balances as zero.

Opening Overview records the latest complete account total for that UTC day, encrypted and scoped to the signed-in user. Repeated visits update that day's observation; earlier days are preserved. This is observation-based history, **not** a background daily sync: no observation is recorded while you do not open Overview. Manual cash/credit/loan balances use a dated reference plus saved later activity; investment and archived accounts retain their entered/saved valuations. The chart shows actual observations within the last 365 days, connecting gaps without manufacturing daily values. Imports never backfill historical net-worth observations. Until two different days have been observed, an insufficient-history message replaces the chart. The chart has no hover/tap interaction, date slider, or visibility toggle.

### Manual accounts and transaction imports

From **Accounts → Add account**, enter the account and institution names, type, currency, and optional last four digits. **Balance** defaults to **0.00** and **End of day** supplies its reference date. The two fields sit side by side on desktop and stack on phones. For credit cards and loans, the amount is the amount owed; a negative amount represents an overpayment. After saving, the account detail page offers **Set balance** and **Import transactions**. You can adjust the reference before or after importing. Add the last four digits of your other accounts too: existing account-reference linking, reciprocal transfer matching, and Fidelity ACH transfer recognition use the same rules for imported and previously saved transactions.

Import a **CSV, OFX, or QFX** file, review the preview, and explicitly confirm the import. For CSV files, choose the export's date order and signed-amount convention; use **Back** to inspect or correct suggested column mappings. A single signed amount column or separate debit/credit columns are supported, with an optional transaction ID column. OFX/QFX statement transactions use their posted dates, signed amounts, descriptions, and FITIDs. Investment trade records, multiple account statements, and OFX replacement/deletion correction instructions are rejected rather than silently importing them as ordinary transactions. Files must contain one account's activity in the account's currency. The browser accepts files up to 4 MB, subject to the server's bounded JSON request limit. UTF-8 and BOM-marked UTF-16 text are supported, along with declared OFX legacy encodings such as Windows-1252; undecodable text produces an error instead of silently replacing characters.

The entire file is validated before any transactions are saved; the preview shows at most 50 rows. Invalid files can be corrected without partially importing them. Re-importing the same transaction IDs skips duplicates; conflicting data for an existing ID is rejected rather than overwriting history. Without IDs, matching uses date, description, amount, currency, and occurrence count so repeated identical purchases in a single file are preserved. This fallback cannot distinguish every case across overlapping exports: use stable transaction IDs when available, and inspect the preview counts.

The reference is the balance **at the end of the selected day**. Transactions dated on or before that day are already included; unique posted activity after that day changes a manual cash/credit/loan balance. The preview's **Balance after import** section shows the reference, any previously imported later activity, earlier new transactions with no impact, new later activity, skipped duplicates, and the resulting balance before approval. Batch imports show the same calculation per file in order, excluding cross-file duplicates. If the reference or imported activity changes after preview, confirmation requests a fresh review rather than silently applying a stale calculation.

New dated balance references and amounts used in their calculations support at most two decimal places and an absolute value of **1,000,000,000,000** currency units. The same limit applies to each file's applied activity total and resulting balance, including cumulative batch balances, so previewed pennies remain exact on readback. Out-of-range imports and reanchors are rejected without partial writes; existing undated snapshots are left unchanged.

New accounts left at the default zero are marked **Default balance · not verified**. Existing missing balances are not silently replaced with zero: open the account and choose **Set balance**. Existing undated snapshots remain fixed until you explicitly set a dated reference. Replacing the reference recalculates the balance using saved later transactions, without deleting or re-importing history. Investment values remain manually set: importing cash activity cannot reconstruct portfolio valuations. No past net-worth observations or verified historical balances are inferred from incomplete imports. Existing compatible saved-provider snapshots and transactions remain read-only, with no imports or balance edits into those archived accounts. All reads and writes are scoped to the signed-in user; references, account data, and imported transactions are encrypted at rest.

The app has no bank-data provider integration. Connecting banks, refreshing remote balances, and automatic syncing are unavailable; imports make no external requests. Previously saved timestamps indicate when data was last retrieved, not a live balance. Settings contains Twelve Data key management, profile, password, and sign-out controls.

### Brokerage accounts and holdings snapshots

Investment accounts have **Summary**, **Holdings**, **Activity**, and **Income** views in the existing Finance layout. This is read-only at the brokerage: there are no orders, trades, bank connections, or money movements. Adding a snapshot saves a local encrypted copy in Finance only.

For a manual brokerage account, use **Add snapshot** to enter a valuation date, source label, source account value, separate cash, and a holdings CSV. Download the template from the dialog. This first implementation accepts the template format, not arbitrary broker positions exports or transaction-history files:

```csv
symbol,name,quantity,price,marketValue,costBasis,isCash
DEMO,Example Fund,10,100,1000,800,false
UNKNOWN,Example holding with unknown basis,5,20,100,,false
```

These are fictional examples. Use the account's currency for every amount. Unknown quantity, price, and cost basis are blank, not zero. `marketValue` is the source valuation; Finance does not replace it with quantity times price. `isCash` must be `true` or `false`. If core cash appears as a money-market/cash position with `isCash=true`, enter **0** separate cash so it is not counted twice. Review the snapshot totals and any difference from the source account value before confirming. Negative/short positions and unsupported values are rejected rather than silently rewritten.

Snapshots are immutable records. Adding an older valuation preserves the latest account value; a newer dated snapshot (or the most recently saved snapshot for the same date) updates the manual account's balance reference. Saved-provider accounts remain read-only. Snapshot source dates, reconciliation differences, and unknown basis remain visible. Historical snapshots are not daily portfolio values, investment returns, or backfilled aggregate net-worth history. Live market prices and return calculations are not included.

New Fidelity-format **transaction history** imports preserve source security quantities/prices and categorize recognized trades, distributions, electronic transfers, and fees. Unknown actions remain **Other**. Generic imports, custom cash mappings, and already-imported cash-only records are not silently relabeled; reimporting duplicate history does not enrich those old records. Activity is separate from holdings: a purchase is not household spending and sale proceeds are not investment income. The Income view totals only classified recorded distributions, includes reversals with their sign, and discloses incomplete imported coverage rather than claiming year-to-date totals. A Fidelity `(Cash)` account-type marker does not establish whether a distribution was paid out or reinvested.

### Twelve Data API key

Open **Settings → Twelve Data** to save, replace, or remove your market-data API key. The key is scoped to your signed-in Finance user and encrypted on the server using the existing secret-derived storage key. It is never returned to the browser after saving, placed in browser storage, or configured through an environment variable. Preserve `BETTER_AUTH_SECRET` in secure backups: losing or rotating it without re-encryption also makes saved API keys unreadable.

This panel is setup only. **Saving does not verify the key, contact Twelve Data, spend provider credits, or fetch current/historical prices.** A saved key is labeled **not verified** until provider validation is implemented. Removing the key does not remove your accounts or imported financial data. Use HTTPS outside localhost, and enter the key in Settings rather than chat or source files.

Saved compatible bank data is encrypted using a purpose-specific key derived from `BETTER_AUTH_SECRET`. Back up this secret securely and separately from the database. Changing or losing it makes that saved data unreadable. Older incompatible legacy records remain stored but are not displayed. Removing provider integration does not delete existing financial records or rewrite their encrypted contents. Create a database backup before upgrading.


Each successful push to `main` receives an integer application version from the GitHub Actions workflow run number. The version appears in the lower-left account profile area and is also published as the matching numeric GHCR tag (for example, `ghcr.io/everyonesoftware/finance:42`); `latest` and `sha-...` tags remain available. Local builds show `Version dev` unless `APP_VERSION` is set.

## Production build

```powershell
npm run build
npm run preview
```

The optimized static site is written to `dist`.

### Single-page web app

Finance navigates between pages without reloading the document, including account details, sign-in, and sign-out. Normal URLs, direct links, browser Back/Forward, and opening links in a new tab remain available.

Finance is a regular browser-based web app, without an install manifest, standalone-app metadata, service-worker registration, or offline page. It requires a connection to the Finance server. The application version remains visible beside your profile.

Deploy the new container image to update the server, then refresh the browser after finishing unsaved changes. There are no in-app update checks, background update downloads, or automatic reloads. Publishing a container image alone does not update a running server.

The former `/sw.js` URL serves only a retirement script for browsers that previously registered Finance's worker. When the browser updates that existing registration, the script deletes only `finance-pwa-offline-*` caches and unregisters itself; it does not intercept requests, cache responses, claim tabs, or reload pages. Keep this endpoint available for returning users. Existing home-screen or desktop shortcuts may need to be removed manually. Financial records and pending writes are not cached or queued for offline use. HTML revalidates; frontend bundles use `no-store`.

## Tests

Build and test the frontend and API:

```powershell
npm run build
npm test
```

Exercise the production app in a real browser with isolated sample API responses and no access to your database:

```powershell
npx playwright install chromium
npm run test:browser
```

On Windows the browser suite uses installed Microsoft Edge by default; set `PLAYWRIGHT_CHANNEL` to override the channel. It verifies same-document navigation, existing authentication/profile interactions, absence of PWA registration/install metadata/offline fallback, retirement of existing workers, and desktop/mobile layout. Set `UI_SCREENSHOTS` to an output directory to retain Settings screenshots. CI runs both the regular test suite and this production browser suite before publishing.

## Continuous integration and container publishing

Every push to `main` builds and tests the app with GitHub Actions. When both succeed, the workflow builds and pushes the Docker image to GitHub Container Registry with `latest` and commit-specific `sha-...` tags:

```powershell
docker pull ghcr.io/everyonesoftware/finance:latest
```

The workflow uses `GITHUB_TOKEN` with package-write permission to publish the app image.

## Run with Docker

Build and start the production container:

```powershell
docker compose up --build
```

Copy `.env.example` to `.env` and replace `BETTER_AUTH_SECRET` with a randomly generated value before starting. The app port is bound to host loopback (`127.0.0.1:8080`) and should not be exposed directly to untrusted networks. For public deployment, use a TLS-terminating reverse proxy that forwards to `127.0.0.1:8080`, and set `ORIGIN_URL` to the app's public HTTPS origin. Compose starts the app, applies database migrations on startup, and stores the SQLite database in the `finance-data` named volume. Open [http://localhost:8080](http://localhost:8080). Stop the container with `Ctrl+C`; run `docker compose down` to stop and remove it. Database data remains in the named volume. Back up the SQLite database regularly, and avoid copying it while the app is actively writing; use SQLite's backup mechanism or briefly stop the app.

The `app` service serves both the Vite frontend and TypeScript API from one Node.js process and one image. SQLite is stored on the persistent volume; the existing PostgreSQL volume is not used or removed by this configuration.

## Current backend scope

Better Auth manages registration, username/password login, sessions, profile names, and password changes. SQLite stores authentication data, encrypted manual/saved bank-account snapshots and transactions, properties, and valuation history. Bank-account APIs provide authenticated, owner-scoped reads, manual account creation, dated balance editing, and preview/commit transaction imports for manual accounts. Real-estate creation and valuation controls remain available. The dashboard displays imported and saved transactions and does not invent income, expense, balance-trend, or chart values. Bank linking and synchronization are not implemented. Deployment/bootstrap settings (authentication secret, public origin, database path, and optional server port) remain environment-based.
