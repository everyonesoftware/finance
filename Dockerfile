FROM node:22-bookworm-slim AS build

WORKDIR /app

RUN apt-get update \
  && apt-get install --yes --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build
RUN npm prune --omit=dev

FROM node:22-bookworm-slim AS app

WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY package*.json ./
COPY --from=build /app/dist ./dist
COPY --from=build /app/server-dist ./server-dist
COPY --from=build /app/server/migrations ./server/migrations

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["npm", "run", "start:api"]
