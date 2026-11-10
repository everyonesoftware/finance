import { Hono, type Context } from "hono";
import type Database from "better-sqlite3";
import { decryptBankValue, getBankEncryptionKey } from "./bank-crypto.js";
import { listAccountTransactions, listAllUserTransactions } from "./account-storage.js";
import { getRecentTransactions } from "./transaction-sync.js";

export interface BankRouterDependencies {
  database: Database.Database;
  getUserId: (context: Context) => Promise<string | null>;
  getEncryptionKey: () => Buffer;
}
interface CachedItem {
  item_id: string;
  encrypted_institution_name: string;
  updated_at: number;
}
interface CachedAccount extends CachedItem {
  id: string;
  provider_account_id: string;
  encrypted_data: string;
  retrieved_at: number;
}

// Cached bank data is read-only. No credentials or remote services are needed.
export function createBankAccountsRouter(deps: BankRouterDependencies): Hono {
  const router = new Hono();
  const db = deps.database;
  const userIds = new WeakMap<Request, string>();
  const uid = (context: Context): string => userIds.get(context.req.raw)!;
  function accountsFor(userId: string): Array<Record<string, unknown>> {
    const rows = db.prepare(`
      SELECT a.*, i.encrypted_institution_name, i.updated_at AS retrieved_at
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
  router.all("*", context => context.json({ error: "API endpoint not found." }, 404));
  return router;
}

// Lazy defaults avoid process-global database/auth state in isolated fixtures.
export const bankAccountsRouter: Hono = new Hono();
let defaultRouter: Hono | undefined;
bankAccountsRouter.all("*", async context => {
  if (!defaultRouter) {
    const [{ sqliteClient }, { auth }] = await Promise.all([import("./database.js"), import("./auth.js")]);
    defaultRouter = createBankAccountsRouter({
      database: sqliteClient,
      getUserId: async context => (await auth.api.getSession({ headers: context.req.raw.headers }))?.user.id ?? null,
      getEncryptionKey: getBankEncryptionKey,
    });
  }
  // Hono preserves the mounted prefix in raw URLs; the child expects relative paths.
  const url = new URL(context.req.url);
  const prefix = context.req.routePath.replace(/\*$/, "").replace(/\/$/, "");
  url.pathname = url.pathname.slice(prefix.length) || "/";
  return defaultRouter.fetch(new Request(url, context.req.raw));
});
