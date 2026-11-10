import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { readFile } from "node:fs/promises";
import { auth } from "./auth.js";
import { bankAccountsRouter } from "./bank_accounts.js";
import { realEstateRouter } from "./real_estate.js";
import { settingsRouter } from "./settings.js";
import {
  checkDatabase,
  closeDatabase,
  runMigrations,
} from "./database.js";

const app: Hono = new Hono();
const port: number = Number(process.env["PORT"] ?? 3000);

app.get("/api/health", async (context) => {
  await checkDatabase();
  return context.json({ status: "ok" });
});

app.all("/api/auth/*", (context) => auth.handler(context.req.raw));
app.route("/api/accounts", bankAccountsRouter);
app.route("/api/real-estate", realEstateRouter);
app.route("/api/settings", settingsRouter);
app.use("*", serveStatic({ root: "./dist" }));
app.get("*", async (context) =>
  context.html(await readFile("./dist/index.html", "utf8")),
);

async function startServer(): Promise<void> {
  await runMigrations();

  const server = serve({
    fetch: app.fetch,
    hostname: "0.0.0.0",
    port,
  });

  const shutdown = async (): Promise<void> => {
    server.close();
    await closeDatabase();
  };

  process.once("SIGINT", (): void => {
    void shutdown();
  });
  process.once("SIGTERM", (): void => {
    void shutdown();
  });
}

void startServer();
