import { Hono, type Context } from "hono";
import type Database from "better-sqlite3";
import { decryptBankValue, encryptBankValue, getBankEncryptionKey } from "./bank-crypto.js";
import { randomUUID, createHash } from "node:crypto";
import { parseTransactionImport } from "./transaction-import.js";
import { listAccountTransactions, listAllUserTransactions } from "./account-storage.js";
import { getRecentTransactions } from "./transaction-sync.js";

export interface BankRouterDependencies {
  database: Database.Database;
  getUserId: (context: Context) => Promise<string | null>;
  getEncryptionKey: () => Buffer;
  trustedOrigins?: string[];
}
interface CachedItem {
  item_id: string;
  encrypted_institution_name: string;
  updated_at: number;
}
interface CachedAccount extends CachedItem {
  provider: string;
  id: string;
  provider_account_id: string;
  encrypted_data: string;
  retrieved_at: number;
}
class ImportConflictError extends Error {}

// Provider snapshots remain read-only; manual accounts use local encrypted imports.
export function createBankAccountsRouter(deps: BankRouterDependencies): Hono {
  const router = new Hono();
  const db = deps.database;
  const userIds = new WeakMap<Request, string>();
  const uid = (context: Context): string => userIds.get(context.req.raw)!;
  async function readWrite(context: Context): Promise<Record<string, unknown> | Response> {
    const origin = context.req.header("origin");
    const allowedOrigins = [new URL(context.req.url).origin, ...(deps.trustedOrigins ?? []).map(value => new URL(value).origin)];
    if ((origin && !allowedOrigins.includes(origin)) || context.req.header("sec-fetch-site") === "cross-site") {
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
          if (size > 5 * 1024 * 1024) {
            await reader.cancel();
            return context.json({ error: "Request exceeds 5 MB." }, 413);
          }
          chunks.push(part.value);
        }
      } finally {
        reader.releaseLock();
      }
    }
    try {
      const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value)) throw Error();
      return value as Record<string, unknown>;
    } catch {
      return context.json({ error: "Invalid JSON object." }, 400);
    }
  }
  function accountsFor(userId: string): Array<Record<string, unknown>> {
    const rows = db.prepare(`
      SELECT a.*, i.provider, i.encrypted_institution_name, i.updated_at AS retrieved_at
      FROM bank_account a JOIN bank_item i ON i.item_id = a.item_id AND i.user_id = a.user_id
      WHERE a.user_id = ? AND a.is_active = 1 AND i.provider <> 'legacy'
    `).all(userId) as CachedAccount[];
    if (!rows.length) return [];
    const key = deps.getEncryptionKey();
    return rows.map(row => ({
      ...JSON.parse(decryptBankValue(row.encrypted_data, key)),
      id: row.id,
      itemId: row.item_id,
      providerAccountId: row.provider_account_id,
      source: row.provider === "manual" ? "manual" : "saved",
      canImport: row.provider === "manual",
      institutionName: decryptBankValue(row.encrypted_institution_name, key),
      updatedAt: new Date(row.updated_at * 1000).toISOString(),
      lastRetrievedAt: new Date(row.retrieved_at * 1000).toISOString(),
    }));
  }
  router.use("*", async (context, next) => {
    context.header("Cache-Control", "no-store");
    const userId = await deps.getUserId(context);
    if (!userId) return context.json({ error: "Authentication required." }, 401);
    userIds.set(context.req.raw, userId);
    await next();
  });
  router.onError((_error, context) => context.json({ error: "Unable to read saved bank data." }, 500));
  router.get("/", context => context.json({ configured: false, accounts: accountsFor(uid(context)) }));
  router.post("/", async context => {
    const body = await readWrite(context);
    if (body instanceof Response) return body;
    const text = (value: unknown, max: number) => typeof value === "string" && value.trim().length > 0 && value.length <= max;
    const validBalance = body.currentBalance === undefined || body.currentBalance === null ||
      (typeof body.currentBalance === "number" && Number.isFinite(body.currentBalance));
    const validMask = body.mask === undefined || (typeof body.mask === "string" && /^\d{4}$/.test(body.mask));
    if (!text(body.name, 200) || !text(body.institutionName, 200) || !text(body.subtype, 100) ||
      typeof body.type !== "string" || !["depository", "credit", "investment", "loan"].includes(body.type) ||
      typeof body.currencyCode !== "string" || !/^[A-Z]{3}$/.test(body.currencyCode) || !validMask || !validBalance) {
      return context.json({ error: "Invalid manual account fields." }, 400);
    }
    const userId = uid(context);
    const id = randomUUID();
    const itemId = randomUUID();
    const providerId = randomUUID();
    const enc = (value: string) => encryptBankValue(value, deps.getEncryptionKey());
    db.transaction(() => {
      db.prepare(`INSERT INTO bank_item(item_id,user_id,provider,encrypted_institution_name,encrypted_access_token)
        VALUES(?,?,'manual',?,?)`).run(itemId, userId, enc(body.institutionName as string), enc(""));
      const snapshot = {
        name: body.name, type: body.type, subtype: body.subtype, currencyCode: body.currencyCode,
        mask: body.mask ?? null, currentBalance: body.currentBalance ?? null,
        availableBalance: null, officialName: null,
      };
      db.prepare(`INSERT INTO bank_account(id,item_id,user_id,provider_account_id,encrypted_data)
        VALUES(?,?,?,?,?)`).run(id, itemId, userId, providerId, enc(JSON.stringify(snapshot)));
    })();
    return context.json({ account: accountsFor(userId).find(a => a.id === id) }, 201);
  });
  router.get("/items", context => {
    const userId = uid(context);
    const accounts = accountsFor(userId);
    const items = db.prepare("SELECT item_id, encrypted_institution_name, updated_at FROM bank_item WHERE user_id = ? AND provider <> 'legacy'").all(userId) as CachedItem[];
    return context.json({
      configured: false,
      connections: items.map(item => {
        const children = accounts.filter(account => account.itemId === item.item_id);
        return {
          itemId: item.item_id,
          institutionName: decryptBankValue(item.encrypted_institution_name, deps.getEncryptionKey()),
          lastRetrievedAt: new Date(item.updated_at * 1000).toISOString(),
          accountCount: children.length,
          accounts: children,
        };
      }),
    });
  });
  for (const path of ["/transactions", "/transactions/all"]) {
    router.get(path, context => {
      const userId = uid(context);
      const transactions = listAllUserTransactions(db, userId, deps.getEncryptionKey());
      return context.json({
        transactions: path.endsWith("/all") ? transactions : getRecentTransactions(transactions),
        accounts: accountsFor(userId),
        configured: false,
      });
    });
  }
  router.get("/:accountId/transactions", context => {
    const userId = uid(context);
    const accounts = accountsFor(userId);
    const account = accounts.find(value => value.id === context.req.param("accountId"));
    if (!account) return context.json({ error: "Account not found." }, 404);
    return context.json({
      account,
      transactions: listAccountTransactions(db, userId, account.itemId as string, account.providerAccountId as string, deps.getEncryptionKey()),
      accounts,
    });
  });
  for (const preview of [true, false]) {
    router.post(preview ? "/:accountId/import/preview" : "/:accountId/import", async context => {
      const body = await readWrite(context);
      if (body instanceof Response) return body;
      const userId = uid(context);
      const account = accountsFor(userId).find(a => a.id === context.req.param("accountId"));
      if (!account) return context.json({ error: "Account not found." }, 404);
      if (!account.canImport) return context.json({ error: "Saved accounts cannot import transactions." }, 409);
      if (typeof body.fileName !== "string" || body.fileName.length > 255 || typeof body.content !== "string") {
        return context.json({ error: "fileName and content are required." }, 400);
      }
      const parsed = parseTransactionImport(body.fileName, body.content, String(account.currencyCode), body.csv, {
        mask: account.mask as string | null,
      });
      const key = deps.getEncryptionKey();
      const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
      const occurrences = new Map<string, number>();
      const candidates = parsed.transactions.map(tx => {
        const fingerprint = hash([tx.date, tx.name, tx.amount, tx.iso_currency_code]);
        const occurrence = (occurrences.get(fingerprint) ?? 0) + 1;
        occurrences.set(fingerprint, occurrence);
        // No financial descriptions or source identifiers appear in DB keys.
        // Occurrence ranks preserve identical legitimate rows within a statement.
        const identity = tx.sourceId !== undefined ? ["source", tx.sourceId] : ["row", fingerprint, occurrence];
        const id = hash([userId, account.id, identity]);
        return { id, fingerprint, tx };
      });
      const lookup = db.prepare(`SELECT encrypted_data FROM bank_transaction
        WHERE transaction_id=? AND user_id=? AND account_id=?`);
      const classify = () => {
        let duplicates = 0;
        const fresh: typeof candidates = [];
        const seen = new Map<string, string>();
        for (const candidate of candidates) {
          const existing = lookup.get(candidate.id, userId, account.providerAccountId) as { encrypted_data: string } | undefined;
          const old = existing ? JSON.parse(decryptBankValue(existing.encrypted_data, key)) : undefined;
          const previous = old?.importFingerprint ?? seen.get(candidate.id);
          if (previous && previous !== candidate.fingerprint) {
            throw new ImportConflictError("A source transaction ID conflicts with previously imported contents.");
          }
          if (previous) duplicates++;
          else fresh.push(candidate);
          seen.set(candidate.id, candidate.fingerprint);
        }
        return { duplicates, fresh };
      };
      if (preview) {
        let duplicates = 0;
        try { duplicates = classify().duplicates; }
        catch (error) {
          if (!(error instanceof ImportConflictError)) throw error;
          parsed.errors.push(error.message);
        }
        return context.json({
          ...parsed, transactions: parsed.transactions.slice(0, 50),
          previewTruncated: parsed.transactions.length > 50,
          duplicates, importable: parsed.errors.length ? 0 : parsed.total - duplicates,
        });
      }
      if (parsed.errors.length) return context.json({ error: "Import validation failed.", errors: parsed.errors }, 400);
      try {
        // Recheck IDs under the same SQLite transaction as the writes.
        const counts = db.transaction(() => {
          const { duplicates, fresh } = classify();
          const insert = db.prepare(`INSERT INTO bank_transaction(transaction_id,item_id,user_id,account_id,encrypted_data)
            VALUES(?,?,?,?,?)`);
          for (const { id, fingerprint, tx } of fresh) {
            const payload = {
              ...tx, transaction_id: id, account_id: account.providerAccountId, pending: false,
              importFingerprint: fingerprint, importFileName: body.fileName,
            };
            insert.run(id, account.itemId, userId, account.providerAccountId, encryptBankValue(JSON.stringify(payload), key));
          }
          // Balance snapshots deliberately do not change during transaction imports.
          return { imported: fresh.length, skipped: duplicates };
        })();
        return context.json({ ...counts, account });
      } catch (error) {
        if (error instanceof ImportConflictError) {
          return context.json({ error: error.message }, 409);
        }
        throw error;
      }
    });
  }
  router.all("*", context => context.json({ error: "API endpoint not found." }, 404));
  return router;
}

// Lazy defaults avoid process-global database/auth state in isolated fixtures.
export const bankAccountsRouter: Hono = new Hono();
let defaultRouter: Hono | undefined;
bankAccountsRouter.all("*", async context => {
  if (!defaultRouter) {
    const [{ sqliteClient }, { auth, trustedOrigins }] = await Promise.all([import("./database.js"), import("./auth.js")]);
    defaultRouter = createBankAccountsRouter({
      database: sqliteClient,
      getUserId: async context => (await auth.api.getSession({ headers: context.req.raw.headers }))?.user.id ?? null,
      getEncryptionKey: getBankEncryptionKey,
      trustedOrigins,
    });
  }
  // Hono preserves the mounted prefix in raw URLs; the child expects relative paths.
  const url = new URL(context.req.url);
  const prefix = context.req.routePath.replace(/\*$/, "").replace(/\/$/, "");
  url.pathname = url.pathname.slice(prefix.length) || "/";
  return defaultRouter.fetch(new Request(url, context.req.raw));
});
