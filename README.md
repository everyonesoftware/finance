# Finance

A personal-finance app with a Vite/TypeScript frontend, Hono TypeScript API, Better Auth username/password authentication, SQLite, and Teller-connected accounts. Account snapshots and synced transaction data are stored encrypted at rest.

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

### Teller bank connections

Open **Settings → Teller integration** after signing in. Integration settings are saved per Finance user in SQLite; no Teller environment variables or API restart are required.

- **Application ID:** copy the application ID from your Teller dashboard.
- **Environment:** start with `sandbox` for simulated bank accounts. `development` and `production` connect to real institutions.
- **Client certificate and private key:** paste the PEM values or upload the PEM files in Settings. Teller requires matching credentials in development and production; sandbox does not require them.
- **Token signing key:** copy the application's public token signing key from the Teller dashboard. Live environments require it to verify the signed enrollment and prevent token replay.

Saved certificate/private-key values are never returned to the browser. Blank credential fields preserve saved credentials; use the explicit clear-credentials control to remove them. Credentials, access tokens, institution names, account snapshots, and transactions are encrypted at rest using a purpose-specific key derived from `BETTER_AUTH_SECRET`. Back up this secret securely and separately from the database. Changing or losing it makes saved integration data unreadable. Serve the app over HTTPS outside local development.

The Accounts page uses Teller Connect for bank authentication; Finance does not receive the bank's login credentials. Connect requests balance and transaction access. Clicking an account opens its saved balance/details snapshot and recent synced transactions. Use **Sync transactions** to refresh balances and retrieve transaction history; each enrollment is updated atomically only after all its pages are retrieved. Failed retrievals preserve the prior saved data. Background and webhook sync are not implemented.

Existing connections from a previous integration are retained in the database as legacy records but are not displayed or sent to Teller. They cannot be converted to Teller tokens: reconnect institutions through Teller Connect. Switching Teller applications or environments also requires reconnecting accounts for that configuration. Create a database backup before upgrading.

See Teller's official Connect and API authentication guides for dashboard setup and credential issuance.

Each successful push to `main` receives an integer application version from the GitHub Actions workflow run number. The version appears in the lower-left account profile area and is also published as the matching numeric GHCR tag (for example, `ghcr.io/everyonesoftware/finance:42`); `latest` and `sha-...` tags remain available. Local builds show `Version dev` unless `APP_VERSION` is set.

## Production build

```powershell
npm run build
npm run preview
```

The optimized static site is written to `dist`.

## Tests

Build and test the frontend and API:

```powershell
npm run build
npm test
```

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

Better Auth manages registration, username/password login, sessions, profile names, and password changes. SQLite stores authentication data, per-user Teller settings, enrollments, bank-account snapshots, and transactions. Settings, account, and transaction APIs enforce per-user ownership; financial data and integration secrets are encrypted at rest. The dashboard displays imported transactions and does not invent income, expense, balance-trend, or chart values. Transactions can be synced manually; background and webhook sync are not implemented. Only deployment/bootstrap settings (authentication secret, public origin, database path, and optional server port) remain environment-based.
