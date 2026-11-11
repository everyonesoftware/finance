import { Hono, type Context } from "hono";
import type Database from "better-sqlite3";
import { decryptBankValue, encryptBankValue, getBankEncryptionKey } from "./bank-crypto.js";
import { randomUUID } from "node:crypto";
import { importCandidates, classifyImport, writeImport, ImportConflictError } from "./import-candidates.js";
import { parseTransactionImport } from "./transaction-import.js";
import { ofxSource } from "./ofx-import.js";
import { filenameAccountMasks } from "./filename-account.js";
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

// Provider snapshots remain read-only; manual accounts use local encrypted imports.
export function createBankAccountsRouter(deps: BankRouterDependencies): Hono {
  const router = new Hono();
  const db = deps.database;
  const userIds = new WeakMap<Request, string>();
  const uid = (context: Context): string => userIds.get(context.req.raw)!;
  async function readWrite(context: Context, maxMiB = 5): Promise<Record<string, unknown> | Response> {
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
          if (size > maxMiB * 1024 * 1024) {
            await reader.cancel();
            return context.json({ error: `Request exceeds ${maxMiB} MB.` }, 413);
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
        transactions: path.endsWith("/all") ? transactions : getRecentTransactions(transactions, 5),
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
    router.post(preview ? "/import-batch/preview" : "/import-batch", async context => {
      const body = await readWrite(context, 32);
      if (body instanceof Response) return body;
      if (!Array.isArray(body.files) || !body.files.length || body.files.length > 30 || body.files.some(file =>
        !file || typeof file !== "object" || Array.isArray(file) ||
        typeof file.fileName !== "string" || !file.fileName.trim() || file.fileName.length > 255 ||
        typeof file.content !== "string" || (file.accountId !== undefined && (typeof file.accountId !== "string" || !file.accountId)))) {
        return context.json({ error: "Submit 1 to 30 files with fileName, content and optional accountId." }, 400);
      }
      if (body.files.some(file => Buffer.byteLength(file.content, "utf8") > 4 * 1024 * 1024)) {
        return context.json({ error: "Each file must not exceed 4 MiB." }, 413);
      }
      const userId = uid(context), key = deps.getEncryptionKey();
      const accounts = accountsFor(userId);
      const prepared = body.files.map((file: { fileName: string; content: string; accountId?: string; csv?: unknown }) => {
        const source = /\.(?:ofx|qfx)$/i.test(file.fileName) ? ofxSource(file.content) : {};
        const filenameMasks = filenameAccountMasks(file.fileName);
        // Statement source identity outranks a potentially renamed export file.
        const matches = source.mask ? accounts.filter(a =>
          a.canImport && a.mask === source.mask && a.currencyCode === source.currency && a.type === source.type) : accounts.filter(a =>
          a.canImport && typeof a.mask === "string" && filenameMasks.includes(a.mask) &&
          (!source.currency || a.currencyCode === source.currency) && (!source.type || a.type === source.type));
        const account = file.accountId !== undefined
          ? accounts.find(a => a.id === file.accountId && a.canImport)
          : matches.length === 1 ? matches[0] : undefined;
        const parsed = parseTransactionImport(file.fileName, file.content, String(account?.currencyCode ?? source.currency ?? "USD"), file.csv, { mask: account?.mask as string | null });
        if (account && source.type && account.type !== source.type) parsed.errors.push("Statement type does not match the account.");
        if (file.accountId !== undefined && !account) parsed.errors.push("Destination account is unavailable or cannot import transactions.");
        const result = {
          fileName: file.fileName, accountId: account?.id ?? null,
          status: parsed.errors.length ? "error" : account ? "ready" : "needs-account",
          reason: parsed.errors[0] ?? (account ? file.accountId === undefined && !source.mask ? "Account number matched from filename." : "Destination selected." : matches.length > 1 ? "Multiple destination accounts match; select one." : "Select a destination account."),
          total: parsed.total, duplicates: 0, importable: account && !parsed.errors.length ? parsed.total : 0,
          errors: parsed.errors, columns: parsed.columns, mapping: parsed.mapping, ...(parsed.notes ? { notes: parsed.notes } : {}),
        };
        return { file, account, result, candidates: account ? importCandidates(parsed.transactions, userId, account) : [] };
      });
      const markConflicts = () => {
        const seen = new Map<string, string>();
        const conflicts = new Set<string>();
        for (const p of prepared) {
          if (!p.account || p.result.errors.length) continue;
          classifyImport(db, key, userId, p.account, p.candidates, seen, conflicts);
        }
        for (const p of prepared) {
          if (p.candidates.some(c => conflicts.has(c.id))) {
            p.result.status = "error";
            p.result.reason = "A source transaction ID conflicts with previously imported contents.";
            p.result.errors.push(p.result.reason);
            p.result.importable = 0;
          }
        }
        return conflicts.size > 0;
      };
      const classify = () => {
        const seen = new Map<string, string>();
        return prepared.map(p => p.account && !p.result.errors.length
          ? classifyImport(db, key, userId, p.account, p.candidates, seen)
          : { duplicates: 0, fresh: [] });
      };
      if (preview) {
        markConflicts();
        const counts = classify();
        prepared.forEach((p, i) => { p.result.duplicates = counts[i].duplicates; p.result.importable = p.result.status === "ready" ? counts[i].fresh.length : 0; });
        return context.json({ files: prepared.map(p => p.result) });
      }
      if (prepared.some(p => !p.file.accountId || p.result.status !== "ready")) return context.json({ error: "Every file requires a valid explicit destination and valid transactions." }, 400);
      try {
        const files = db.transaction(() => {
          const counts = classify();
          return prepared.map((p, i) => {
            writeImport(db, key, userId, p.account!, p.file.fileName, counts[i].fresh);
            return { fileName: p.file.fileName, accountId: p.account!.id, imported: counts[i].fresh.length, skipped: counts[i].duplicates };
          });
        })();
        return context.json({ files, imported: files.reduce((n, f) => n + f.imported, 0), skipped: files.reduce((n, f) => n + f.skipped, 0) });
      } catch (error) {
        if (error instanceof ImportConflictError) return context.json({ error: error.message }, 409);
        throw error;
      }
    });
  }
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
      const candidates = importCandidates(parsed.transactions, userId, account);
      const classify = () => classifyImport(db, key, userId, account, candidates);
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
          writeImport(db, key, userId, account, body.fileName as string, fresh);
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
