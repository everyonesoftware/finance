import { Hono, type Context } from "hono";
import type Database from "better-sqlite3";
import { encryptBankValue, getBankEncryptionKey } from "./bank-crypto.js";

interface TwelveDataSettingsDependencies {
  database: Database.Database;
  getUserId: (context: Context) => Promise<string | null>;
  getEncryptionKey: () => Buffer;
  trustedOrigins?: string[];
}

// Key management only: saving never calls the provider or spends API credits.
export function createTwelveDataSettingsRouter(deps: TwelveDataSettingsDependencies): Hono {
  const router = new Hono();
  const users = new WeakMap<Request, string>();
  router.use("*", async (context, next) => {
    context.header("Cache-Control", "no-store");
    const user = await deps.getUserId(context);
    if (!user) return context.json({ error: "Authentication required." }, 401);
    users.set(context.req.raw, user);
    await next();
  });
  // Never echo exceptions: request bodies and storage errors may contain secrets.
  router.onError((_error, context) => context.json({ error: "Unable to access Twelve Data settings." }, 500));
  router.get("/", context => {
    const row = deps.database.prepare("SELECT 1 FROM twelve_data_settings WHERE user_id = ?").get(users.get(context.req.raw)!);
    return context.json({ configured: Boolean(row) });
  });
  async function readWrite(context: Context): Promise<Record<string, unknown> | Response> {
    const origin = context.req.header("origin");
    const allowed = [new URL(context.req.url).origin, ...(deps.trustedOrigins ?? []).map(value => new URL(value).origin)];
    if ((origin && !allowed.includes(origin)) || context.req.header("sec-fetch-site") === "cross-site") {
      return context.json({ error: "Cross-origin writes are forbidden." }, 403);
    }
    if (!/^application\/json(?:\s*;|$)/i.test(context.req.header("content-type") ?? "")) {
      return context.json({ error: "A JSON request is required." }, 400);
    }
    const reader = context.req.raw.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > 4096) {
            await reader.cancel();
            return context.json({ error: "Request exceeds 4 KB." }, 413);
          }
          chunks.push(part.value);
        }
      } finally { reader.releaseLock(); }
    }
    try {
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!body || typeof body !== "object" || Array.isArray(body)) throw Error();
      return body as Record<string, unknown>;
    } catch { return context.json({ error: "Invalid JSON object." }, 400); }
  }
  router.put("/", async context => {
    const body = await readWrite(context);
    if (body instanceof Response) return body;
    // Bound storage without assuming an undocumented provider key format.
    if (Object.keys(body).length !== 1 || typeof body.apiKey !== "string" || !/^[\x21-\x7e]{1,1024}$/.test(body.apiKey)) {
      return context.json({ error: "Enter an API key without spaces, up to 1,024 characters." }, 400);
    }
    const encrypted = encryptBankValue(body.apiKey, deps.getEncryptionKey());
    deps.database.prepare(`INSERT INTO twelve_data_settings(user_id, encrypted_api_key) VALUES(?, ?)
      ON CONFLICT(user_id) DO UPDATE SET encrypted_api_key = excluded.encrypted_api_key`)
      .run(users.get(context.req.raw)!, encrypted);
    return context.json({ configured: true });
  });
  router.delete("/", async context => {
    const body = await readWrite(context);
    if (body instanceof Response) return body;
    if (Object.keys(body).length) return context.json({ error: "An empty JSON object is required." }, 400);
    deps.database.prepare("DELETE FROM twelve_data_settings WHERE user_id = ?").run(users.get(context.req.raw)!);
    return context.json({ configured: false });
  });
  router.all("*", context => context.json({ error: "API endpoint not found." }, 404));
  return router;
}

export const twelveDataSettingsRouter = new Hono();
let defaultRouter: Hono | undefined;
twelveDataSettingsRouter.all("*", async context => {
  if (!defaultRouter) {
    const [{ sqliteClient }, { auth, trustedOrigins }] = await Promise.all([import("./database.js"), import("./auth.js")]);
    defaultRouter = createTwelveDataSettingsRouter({
      database: sqliteClient,
      getUserId: async context => (await auth.api.getSession({ headers: context.req.raw.headers }))?.user.id ?? null,
      getEncryptionKey: getBankEncryptionKey,
      trustedOrigins,
    });
  }
  const url = new URL(context.req.url);
  const prefix = context.req.routePath.replace(/\*$/, "").replace(/\/$/, "");
  url.pathname = url.pathname.slice(prefix.length) || "/";
  return defaultRouter.fetch(new Request(url, context.req.raw));
});
