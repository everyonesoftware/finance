# Ledger

A starter personal-finance dashboard built with Vite and TypeScript. The current dashboard is a static UI scaffold; account connections, transaction storage, and authentication are not wired up yet.

## Requirements

- Node.js 22 or newer
- npm
- Docker with the Compose plugin (for container use)

## Local development

```powershell
npm install
npm run dev
```

Vite prints the local URL when the development server is ready.

## Production build

```powershell
npm run build
npm run preview
```

The optimized static site is written to `dist`.

## Tests

Run the production-build smoke test after building:

```powershell
npm test
```

## Continuous integration and container publishing

Every push to `main` builds and tests the app with GitHub Actions. When both succeed, the workflow builds and pushes the Docker image to GitHub Container Registry with `latest` and commit-specific `sha-...` tags:

```powershell
docker pull ghcr.io/everyonesoftware/finance:latest
```

The workflow uses `GITHUB_TOKEN` with package-write permission to publish the image.

## Run with Docker

Build and start the production container:

```powershell
docker compose up --build
```

Open [http://localhost:8080](http://localhost:8080). Stop the container with `Ctrl+C`; run `docker compose down` to remove it.

The Docker build uses Node.js to compile the app and Nginx to serve the resulting static files. The `web` service listens on container port 80 and maps it to host port 8080.
