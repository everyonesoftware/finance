# Native Finance clients: server contract

The native clients connect to an existing Finance installation using the same username and password as the web app. The entered URL is the public Finance origin (the server's `ORIGIN_URL`), not a bank URL or a path under `/api`. Use HTTPS outside isolated local development. Account creation continues to be available in the web app. The server is the source of truth for balances, transactions, and real estate; the native clients do not introduce a separate ledger or bank connection.

## Authentication

1. Send JSON `{ "username": "…", "password": "…" }` to `POST /api/auth/sign-in/username`. Do not follow redirects on requests carrying password or session credentials. Do not save the password.
2. Use the server-issued session cookie only for requests to the exact origin that issued it. `GET /api/auth/get-session` identifies the bearer of that cookie; an anonymous session can be represented by JSON `null` rather than an HTTP error. An authenticated ledger read can also establish that the session is usable. HTTPS deployments use a Secure, HttpOnly cookie.
3. Send the exact configured origin as the `Origin` header on JSON POSTs. In particular, `POST /api/auth/sign-out` with an authenticated cookie and an empty JSON object needs the origin or Better Auth rejects it. Clear local session state on sign-out and do not use another origin's cookie when switching servers.

## Existing server routes

- `GET /api/accounts/net-worth`: server-calculated total and observed history.
- `GET /api/accounts`: account collection.
- `GET /api/accounts/:accountId/transactions`: account details and associated transactions.
- `GET /api/accounts/transactions/all`: all saved transactions and their associated account data.
- `GET /api/real-estate`: saved property data.
- `POST /api/accounts/:accountId/import/preview` and `POST /api/accounts/:accountId/import`: server-side validation and explicit confirmation of transaction files for a manual account. Keep the approval tied to the preview and the selected account; a server conflict requires a fresh preview, not an automatic write retry.

`node --import tsx --test tests/native-server-session.test.js` exercises the real Better Auth and account routers against a disposable migrated SQLite database. It checks invalid credentials, secure session issuance, ledger access, isolation between two users, and session invalidation after sign-out. It does not substitute for native UI or native transport acceptance.
