# Finance

A personal-finance app starter with a Vite/TypeScript frontend, a Hono TypeScript API, Better Auth username/password authentication, and SQLite. Dashboard balances and transactions are still sample content.

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

### Plaid bank connections

Create a Plaid account and use its Sandbox credentials to enable bank linking. Add `PLAID_CLIENT_ID` and `PLAID_SECRET` from the Plaid Dashboard to `.env`, leave `PLAID_ENV=sandbox`, and generate a separate 32-byte encryption key:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Set that value as `PLAID_TOKEN_ENCRYPTION_KEY`. Keep the Plaid credentials and encryption key out of source control. The key is required to decrypt stored access tokens and account data; back it up securely and separately from the database. Losing it makes saved Plaid connections unreadable. Restart the API after changing the environment.

The Accounts page uses Plaid Link; Finance never receives or stores the bank's login credentials. For account balances, Link requests the Plaid Transactions product with a 30-day history window (Plaid's minimum in Production). Finance currently fetches and stores only account names, account type, masked number, currency, and balances; it does not fetch or store transaction history. Plaid access tokens, institution names, and account snapshots are encrypted at rest using the configured key. Test with Plaid Sandbox institutions and credentials; connecting a real Ally Bank account requires eligible Plaid Production access and real-account setup through Plaid.

## Production build

```powershell
npm run build
npm run preview
```

The optimized static site is written to `dist`.

## Tests

Build and test the frontend and API:

```powershell
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

Better Auth manages registration, username/password login, sessions, profile names, and password changes. SQLite stores authentication users, accounts, sessions, and verification records. The financial dashboard remains sample data; financial account and transaction tables, API routes, and per-user data authorization have not been implemented yet. Do not treat the current frontend route checks as authorization for future financial data—enforce ownership in the API for every data operation.
