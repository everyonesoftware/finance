# Finance

A personal-finance app with a Vite/TypeScript frontend, Hono TypeScript API, Better Auth username/password authentication, SQLite, manual financial accounts, transaction imports, saved bank-account views, and real-estate tracking. Saved financial data is encrypted at rest.

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

### Manual accounts and transaction imports

From **Accounts → Add account**, enter the account and institution names, type, currency, and optional last four digits and current balance. After saving, the account detail page offers **Import transactions**. Add the last four digits of your other accounts too: existing account-reference linking, reciprocal transfer matching, and Fidelity ACH transfer recognition use the same rules for imported and previously saved transactions.

Import a **CSV, OFX, or QFX** file, review the preview, and explicitly confirm the import. For CSV files, choose the export's date order and signed-amount convention; use **Back** to inspect or correct suggested column mappings. A single signed amount column or separate debit/credit columns are supported, with an optional transaction ID column. OFX/QFX statement transactions use their posted dates, signed amounts, descriptions, and FITIDs. Investment trade records, multiple account statements, and OFX replacement/deletion correction instructions are rejected rather than silently importing them as ordinary transactions. Files must contain one account's activity in the account's currency. The browser accepts files up to 4 MB, subject to the server's bounded JSON request limit. UTF-8 and BOM-marked UTF-16 text are supported, along with declared OFX legacy encodings such as Windows-1252; undecodable text produces an error instead of silently replacing characters.

The entire file is validated before any transactions are saved; the preview shows at most 50 rows. Invalid files can be corrected without partially importing them. Re-importing the same transaction IDs skips duplicates; conflicting data for an existing ID is rejected rather than overwriting history. Without IDs, matching uses date, description, amount, currency, and occurrence count so repeated identical purchases in a single file are preserved. This fallback cannot distinguish every case across overlapping exports: use stable transaction IDs when available, and inspect the preview counts.

The optional balance is an explicitly entered snapshot, not a running ledger balance. Importing historical transactions **does not change it**. Existing compatible saved account snapshots and transactions remain read-only, with no imports into those archived accounts. New manual accounts and all reads/imports are scoped to the signed-in user. Account data and imported transactions are encrypted at rest.

The app has no bank-data provider integration. Connecting banks, refreshing remote balances, and automatic syncing are unavailable; imports make no external requests. Previously saved timestamps indicate when data was last retrieved, not a live balance. Settings contains profile, password, and sign-out controls.

Saved compatible bank data is encrypted using a purpose-specific key derived from `BETTER_AUTH_SECRET`. Back up this secret securely and separately from the database. Changing or losing it makes that saved data unreadable. Older incompatible legacy records remain stored but are not displayed. Removing provider integration does not delete existing financial records or rewrite their encrypted contents. Create a database backup before upgrading.


Each successful push to `main` receives an integer application version from the GitHub Actions workflow run number. The version appears in the lower-left account profile area and is also published as the matching numeric GHCR tag (for example, `ghcr.io/everyonesoftware/finance:42`); `latest` and `sha-...` tags remain available. Local builds show `Version dev` unless `APP_VERSION` is set.

## Production build

```powershell
npm run build
npm run preview
```

The optimized static site is written to `dist`.

### Single-page app, installation, and updates

Finance navigates between pages without reloading the document, including account details, sign-in, and sign-out. Normal URLs, direct links, browser Back/Forward, and opening links in a new tab remain available.

Production builds include a web app manifest and service worker. Serve Finance over HTTPS (or localhost) to enable PWA support; use the browser's **Install app** or **Add to Home Screen** action where supported. The Vite development server does not register the production worker.

Open **Settings** using the gear beside your profile at the bottom left (beside your name in the mobile header). **App updates → Check for updates** checks the deployed build and worker. When a new version is ready, choose **Reload to update** or **Later**. Discovery never automatically reloads an open session, and applying from another tab does not reload this tab. Finish unsaved changes before applying an update. Publishing a container image alone does not update a running server: deploy the new image before checking for it in Finance.

Offline support is deliberately limited to a public disconnected page with **Retry connection**. Financial records, API responses, authenticated screens, and pending writes are not cached or queued for offline use. Reconnect to read or change your finances. The worker's Cache Storage contains only `/offline.html`, and cleanup is restricted to Finance's own offline caches. HTML, worker, and update metadata revalidate; frontend bundles use `no-store`.

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

On Windows the browser suite uses installed Microsoft Edge by default; set `PLAYWRIGHT_CHANNEL` to override the channel. It verifies same-document navigation, existing authentication/profile interactions, manifest/installability, actual worker updates and explicit reload, offline privacy/no replay, and desktop/mobile layout. Set `UI_SCREENSHOTS` to an output directory to retain Settings screenshots. CI runs both the regular test suite and this production browser suite before publishing.

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

Better Auth manages registration, username/password login, sessions, profile names, and password changes. SQLite stores authentication data, encrypted manual/saved bank-account snapshots and transactions, properties, and valuation history. Bank-account APIs provide authenticated, owner-scoped reads, manual account creation, and preview/commit transaction imports for manual accounts. Real-estate creation and valuation controls remain available. The dashboard displays imported and saved transactions and does not invent income, expense, balance-trend, or chart values. Bank linking and synchronization are not implemented. Deployment/bootstrap settings (authentication secret, public origin, database path, and optional server port) remain environment-based.
