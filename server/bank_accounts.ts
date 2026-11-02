import type { Context } from "hono";
import { Hono } from "hono";
import {
  CountryCode,
  Products,
  type AccountBase,
} from "plaid";
import { auth } from "./auth.js";
import { bankAccount, bankItem } from "./schema.js";
import { database, sqliteClient } from "./database.js";
import {
  decryptPlaidValue,
  encryptPlaidValue,
  getPlaidErrorLogDetails,
  getPlaidConnection,
  readPlaidTransactionCursor,
  PlaidConfigurationError,
  type PlaidErrorLogContext,
} from "./plaid.js";
import { and, eq } from "drizzle-orm";
import {
  listAccountTransactions,
  listAllUserTransactions,
  refreshBankAccountSnapshots,
} from "./account-storage.js";
import { collectTransactionPages, getRecentTransactions } from "./transaction-sync.js";

interface AccountSnapshot {
  name: string;
  officialName: string | null;
  type: string;
  subtype: string | null;
  mask: string | null;
  currentBalance: number | null;
  availableBalance: number | null;
  currencyCode: string | null;
}

interface BankAccountResponse extends AccountSnapshot {
  id: string;
  itemId: string;
  plaidAccountId: string;
  institutionName: string;
  updatedAt: string;
  lastRetrievedAt: string;
}

interface BankItemRecord {
  itemId: string;
  userId: string;
  encryptedInstitutionName: string;
  encryptedAccessToken: string;
}

interface TransactionSyncItem {
  itemId: string;
  token: string;
  cursor: string | null;
}

type PlaidSyncConnection = NonNullable<ReturnType<typeof getPlaidConnection>>;

const bankAccountsRouter: Hono = new Hono();

class BankItemOwnershipError extends Error {}

function isTrustedOrigin(origin: string | undefined): boolean {
  if (!origin) {
    return false;
  }

  let requestOrigin: string;
  try {
    requestOrigin = new URL(origin).origin;
  } catch {
    return false;
  }

  const configuredOrigin: string | undefined = process.env["ORIGIN_URL"];
  const trustedOrigins: string[] = [
    ...(configuredOrigin ? [new URL(configuredOrigin).origin] : []),
    "http://localhost:5173",
    "http://127.0.0.1:5173",
  ];

  return trustedOrigins.includes(requestOrigin);
}

async function getUserId(context: Context): Promise<string | null> {
  const session = await auth.api.getSession({
    headers: context.req.raw.headers,
  });
  return session?.user.id ?? null;
}

function toSnapshot(account: AccountBase): AccountSnapshot {
  return {
    name: account.name,
    officialName: account.official_name,
    type: account.type,
    subtype: account.subtype,
    mask: account.mask,
    currentBalance: account.balances.current,
    availableBalance: account.balances.available,
    currencyCode:
      account.balances.iso_currency_code ??
      account.balances.unofficial_currency_code,
  };
}

function decodeSnapshot(value: string): AccountSnapshot {
  const parsed: unknown = JSON.parse(value);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("name" in parsed) ||
    typeof parsed.name !== "string" ||
    !("type" in parsed) ||
    typeof parsed.type !== "string" ||
    !("officialName" in parsed) ||
    !(typeof parsed.officialName === "string" || parsed.officialName === null) ||
    !("subtype" in parsed) ||
    !(typeof parsed.subtype === "string" || parsed.subtype === null) ||
    !("mask" in parsed) ||
    !(typeof parsed.mask === "string" || parsed.mask === null) ||
    !("currentBalance" in parsed) ||
    !(typeof parsed.currentBalance === "number" || parsed.currentBalance === null) ||
    !("availableBalance" in parsed) ||
    !(typeof parsed.availableBalance === "number" || parsed.availableBalance === null) ||
    !("currencyCode" in parsed) ||
    !(typeof parsed.currencyCode === "string" || parsed.currencyCode === null)
  ) {
    throw new Error("Stored bank account data is invalid.");
  }

  return {
    name: parsed.name,
    officialName: parsed.officialName,
    type: parsed.type,
    subtype: parsed.subtype,
    mask: parsed.mask,
    currentBalance: parsed.currentBalance,
    availableBalance: parsed.availableBalance,
    currencyCode: parsed.currencyCode,
  };
}

function getAccountsForUser(userId: string): BankAccountResponse[] {
  const connection = getPlaidConnection();
  const records: Array<{
    id: string;
    itemId: string;
    plaidAccountId: string;
    encryptedInstitutionName: string;
    encryptedData: string;
    updatedAt: Date;
    lastRetrievedAt: Date;
  }> = database
    .select({
      id: bankAccount.id,
      itemId: bankAccount.itemId,
      plaidAccountId: bankAccount.plaidAccountId,
      encryptedInstitutionName: bankItem.encryptedInstitutionName,
      encryptedData: bankAccount.encryptedData,
      updatedAt: bankAccount.updatedAt,
      lastRetrievedAt: bankItem.updatedAt,
    })
    .from(bankAccount)
    .innerJoin(bankItem, eq(bankAccount.itemId, bankItem.itemId))
    .where(and(eq(bankAccount.userId, userId), eq(bankAccount.isActive, true)))
    .all();

  if (records.length > 0 && !connection) {
    throw new PlaidConfigurationError(
      "The Plaid encryption key is required to read stored bank accounts.",
    );
  }

  return records.map((record): BankAccountResponse => {
    if (!connection) {
      throw new Error("Bank account encryption is unavailable.");
    }

    const snapshot: AccountSnapshot = decodeSnapshot(
      decryptPlaidValue(record.encryptedData, connection.encryptionKey),
    );
    return {
      ...snapshot,
      id: record.id,
      itemId: record.itemId,
      plaidAccountId: record.plaidAccountId,
      institutionName: decryptPlaidValue(
        record.encryptedInstitutionName,
        connection.encryptionKey,
      ),
      updatedAt: record.updatedAt.toISOString(),
      lastRetrievedAt: record.lastRetrievedAt.toISOString(),
    };
  });
}

function saveAccounts(
  userId: string,
  itemId: string,
  institutionName: string,
  institutionId: string | null,
  encryptedAccessToken: string,
  accounts: AccountBase[],
  encryptionKey: Buffer,
): void {
  const save = sqliteClient.transaction((): void => {
    const existing: { user_id: string } | undefined = sqliteClient
      .prepare("SELECT user_id FROM bank_item WHERE item_id = ?")
      .get(itemId) as { user_id: string } | undefined;

    if (existing && existing.user_id !== userId) {
      throw new BankItemOwnershipError();
    }

    sqliteClient
      .prepare(`
        INSERT INTO bank_item (
          item_id,
          user_id,
          institution_id,
          encrypted_institution_name,
          encrypted_access_token
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(item_id) DO UPDATE SET
          institution_id = excluded.institution_id,
          encrypted_institution_name = excluded.encrypted_institution_name,
          encrypted_access_token = excluded.encrypted_access_token,
          updated_at = unixepoch()
      `)
      .run(
        itemId,
        userId,
        institutionId,
        encryptPlaidValue(institutionName, encryptionKey),
        encryptedAccessToken,
      );

    refreshBankAccountSnapshots(
      sqliteClient,
      itemId,
      userId,
      accounts.map((account) => ({
        plaidAccountId: account.account_id,
        encryptedData: encryptPlaidValue(
          JSON.stringify(toSnapshot(account)),
          encryptionKey,
        ),
      })),
    );
  });

  save();
}

function logPlaidFailure(
  operation: string,
  error: unknown,
  context?: PlaidErrorLogContext,
): void {
  console.error(
    `Bank data operation failed: ${JSON.stringify(
      getPlaidErrorLogDetails(operation, error, context),
    )}`,
  );
}

async function syncPlaidItem(
  item: TransactionSyncItem,
  userId: string,
  connection: PlaidSyncConnection,
  itemNumber: number,
  itemCount: number,
  setFailureContext: (context: PlaidErrorLogContext) => void,
): Promise<void> {
  const itemContext = { itemNumber, itemCount };
  setFailureContext({ ...itemContext, phase: "decrypt access token" });
  const access_token = decryptPlaidValue(item.token, connection.encryptionKey);

  setFailureContext({ ...itemContext, phase: "decrypt saved transaction cursor" });
  const cursorRead = readPlaidTransactionCursor(item.cursor, connection.encryptionKey);
  if (cursorRead.recovered) {
    console.warn(
      "Saved transaction cursor format is unsupported; retrying this item from an initial sync.",
      JSON.stringify(itemContext),
    );
  }

  setFailureContext({ ...itemContext, phase: "request Plaid transaction page" });
  const batch = await collectTransactionPages(async ({ cursor }) => {
    setFailureContext({ ...itemContext, phase: "request Plaid transaction page" });
    const page = await connection.client.transactionsSync({
      access_token,
      ...(cursor ? { cursor } : {}),
      count: 500,
    });
    return page.data;
  }, cursorRead.cursor);

  setFailureContext({ ...itemContext, phase: "validate and persist transaction batch" });
  const commit = sqliteClient.transaction(() => {
    const del = sqliteClient.prepare("DELETE FROM bank_transaction WHERE item_id=? AND transaction_id=? AND user_id=?");
    for (const removed of batch.removed) del.run(item.itemId, removed.transaction_id, userId);
    const up = sqliteClient.prepare("INSERT INTO bank_transaction(transaction_id,item_id,user_id,account_id,encrypted_data) VALUES(?,?,?,?,?) ON CONFLICT(item_id,transaction_id) DO UPDATE SET account_id=excluded.account_id, encrypted_data=excluded.encrypted_data, updated_at=unixepoch()");
    const accountIds = new Set((sqliteClient.prepare("SELECT plaid_account_id AS id FROM bank_account WHERE item_id=? AND user_id=?").all(item.itemId, userId) as Array<{ id: string }>).map((account) => account.id));
    for (const transaction of [...batch.added, ...batch.modified]) {
      if (!accountIds.has(transaction.account_id)) {
        throw new Error("Plaid transaction references an account outside this item.");
      }
      up.run(
        transaction.transaction_id,
        item.itemId,
        userId,
        transaction.account_id,
        encryptPlaidValue(JSON.stringify(transaction), connection.encryptionKey),
      );
    }
    sqliteClient.prepare("UPDATE bank_item SET encrypted_transaction_cursor=?,updated_at=unixepoch() WHERE item_id=? AND user_id=?")
      .run(encryptPlaidValue(batch.cursor, connection.encryptionKey), item.itemId, userId);
  });
  commit();
}

function configurationFailure(context: Context): Response {
  return context.json(
    { error: "Plaid is not configured. Check the server environment settings." },
    503,
  );
}

function listTransactions(userId: string, key: Buffer) {
  return getRecentTransactions(listAllUserTransactions(sqliteClient, userId, key));
}

bankAccountsRouter.get("/transactions", async (context) => {
  context.header("Cache-Control", "no-store");
  const userId = await getUserId(context);
  if (!userId) return context.json({ error: "Authentication required." }, 401);
  try {
    const connection = getPlaidConnection();
    if (!connection) return context.json({ transactions: [], accounts: [], configured: false });
    return context.json({
      transactions: listTransactions(userId, connection.encryptionKey),
      accounts: getAccountsForUser(userId),
      configured: true,
    });
  } catch (error) {
    if (error instanceof PlaidConfigurationError) return configurationFailure(context);
    logPlaidFailure("transaction listing", error);
    return context.json({ error: "Unable to load transactions." }, 500);
  }
});

bankAccountsRouter.get("/transactions/all", async (context) => {
  context.header("Cache-Control", "no-store");
  const userId = await getUserId(context);
  if (!userId) return context.json({ error: "Authentication required." }, 401);
  try {
    const connection = getPlaidConnection();
    if (!connection) return context.json({ transactions: [], accounts: [], configured: false });
    return context.json({
      transactions: listAllUserTransactions(sqliteClient, userId, connection.encryptionKey),
      accounts: getAccountsForUser(userId),
      configured: true,
    });
  } catch (error) {
    if (error instanceof PlaidConfigurationError) return configurationFailure(context);
    logPlaidFailure("all transaction listing", error);
    return context.json({ error: "Unable to load transactions." }, 500);
  }
});

bankAccountsRouter.get("/:accountId/transactions", async (context) => {
  context.header("Cache-Control", "no-store");
  const userId = await getUserId(context);
  if (!userId) return context.json({ error: "Authentication required." }, 401);

  const accountId = context.req.param("accountId");
  try {
    const metadata = sqliteClient
      .prepare(`
        SELECT item_id AS itemId, plaid_account_id AS plaidAccountId
        FROM bank_account
        WHERE id = ? AND user_id = ? AND is_active = 1
      `)
      .get(accountId, userId) as { itemId: string; plaidAccountId: string } | undefined;
    if (!metadata) return context.json({ error: "Account not found." }, 404);

    const account = getAccountsForUser(userId).find((candidate) => candidate.id === accountId);
    if (!account) return context.json({ error: "Account not found." }, 404);

    const connection = getPlaidConnection();
    if (!connection) return configurationFailure(context);
    const transactions = listAccountTransactions(
      sqliteClient,
      userId,
      metadata.itemId,
      metadata.plaidAccountId,
      connection.encryptionKey,
    );
    return context.json({ account, transactions, accounts: getAccountsForUser(userId) });
  } catch (error) {
    if (error instanceof PlaidConfigurationError) return configurationFailure(context);
    logPlaidFailure("account transaction listing", error);
    return context.json({ error: "Unable to load this account." }, 500);
  }
});

bankAccountsRouter.post("/transactions/sync", async (context) => {
  context.header("Cache-Control", "no-store");
  if (!isTrustedOrigin(context.req.header("origin"))) {
    return context.json({ error: "Request origin is not allowed." }, 403);
  }
  const userId = await getUserId(context);
  if (!userId) return context.json({ error: "Authentication required." }, 401);

  let connection;
  try {
    connection = getPlaidConnection();
  } catch (error) {
    if (error instanceof PlaidConfigurationError) return configurationFailure(context);
    throw error;
  }
  if (!connection) return configurationFailure(context);

  let failureContext: PlaidErrorLogContext = { phase: "load connected items" };
  try {
    const items = sqliteClient
      .prepare("SELECT item_id AS itemId, encrypted_access_token AS token, encrypted_transaction_cursor AS cursor FROM bank_item WHERE user_id = ?")
      .all(userId) as TransactionSyncItem[];

    for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
      const item = items[itemIndex];
      if (!item) continue;
      await syncPlaidItem(item, userId, connection, itemIndex + 1, items.length, (nextContext) => {
        failureContext = nextContext;
      });
    }

    failureContext = { phase: "load saved transaction list" };
    return context.json({ transactions: listTransactions(userId, connection.encryptionKey) });
  } catch (error) {
    logPlaidFailure("transaction sync", error, failureContext);
    return context.json({ error: "Unable to sync transactions. Please retry." }, 502);
  }
});

bankAccountsRouter.post("/items/:itemId/transactions/sync", async (context) => {
  context.header("Cache-Control", "no-store");
  if (!isTrustedOrigin(context.req.header("origin"))) {
    return context.json({ error: "Request origin is not allowed." }, 403);
  }
  const userId = await getUserId(context);
  if (!userId) return context.json({ error: "Authentication required." }, 401);

  const itemId = context.req.param("itemId");
  if (itemId.length === 0 || itemId.length > 256) {
    return context.json({ error: "Invalid bank connection identifier." }, 400);
  }

  const item = sqliteClient
    .prepare("SELECT item_id AS itemId, encrypted_access_token AS token, encrypted_transaction_cursor AS cursor FROM bank_item WHERE item_id = ? AND user_id = ?")
    .get(itemId, userId) as TransactionSyncItem | undefined;
  if (!item) return context.json({ error: "Bank connection not found." }, 404);

  let connection: PlaidSyncConnection | null;
  try {
    connection = getPlaidConnection();
  } catch (error) {
    if (error instanceof PlaidConfigurationError) return configurationFailure(context);
    throw error;
  }
  if (!connection) return configurationFailure(context);

  let failureContext: PlaidErrorLogContext = {
    phase: "decrypt access token",
    itemNumber: 1,
    itemCount: 1,
  };
  try {
    await syncPlaidItem(item, userId, connection, 1, 1, (nextContext) => {
      failureContext = nextContext;
    });
    return context.json({ synced: true });
  } catch (error) {
    logPlaidFailure("transaction sync", error, failureContext);
    return context.json({ error: "Unable to sync this institution. Please retry." }, 502);
  }
});

bankAccountsRouter.get("/", async (context) => {
  context.header("Cache-Control", "no-store");

  const userId: string | null = await getUserId(context);
  if (!userId) {
    return context.json({ error: "Authentication required." }, 401);
  }

  try {
    return context.json({
      configured: getPlaidConnection() !== null,
      accounts: getAccountsForUser(userId),
    });
  } catch (error: unknown) {
    if (error instanceof PlaidConfigurationError) {
      console.error(error.message);
      return configurationFailure(context);
    }
    logPlaidFailure("account listing", error);
    return context.json({ error: "Unable to load bank accounts." }, 500);
  }
});

bankAccountsRouter.get("/items", async (context) => {
  context.header("Cache-Control", "no-store");
  const userId = await getUserId(context);
  if (!userId) return context.json({ error: "Authentication required." }, 401);
  try {
    const connection = getPlaidConnection();
    const items = sqliteClient.prepare(`
      SELECT item_id AS itemId, encrypted_institution_name AS encryptedInstitutionName,
        updated_at AS updatedAt,
        (SELECT COUNT(*) FROM bank_account WHERE bank_account.item_id = bank_item.item_id AND user_id = ? AND is_active = 1) AS accountCount
      FROM bank_item WHERE user_id = ? ORDER BY updated_at DESC
    `).all(userId, userId) as Array<{ itemId: string; encryptedInstitutionName: string; updatedAt: number; accountCount: number }>;
    if (items.length && !connection) return configurationFailure(context);
    const accounts = getAccountsForUser(userId);
    return context.json({ configured: connection !== null, connections: items.map((item) => ({
      itemId: item.itemId,
      institutionName: decryptPlaidValue(item.encryptedInstitutionName, connection!.encryptionKey),
      lastRetrievedAt: new Date(item.updatedAt * 1000).toISOString(),
      accountCount: item.accountCount,
      accounts: accounts.filter((account) => account.itemId === item.itemId),
    })) });
  } catch (error) {
    if (error instanceof PlaidConfigurationError) return configurationFailure(context);
    logPlaidFailure("connection listing", error);
    return context.json({ error: "Unable to load Plaid connections." }, 500);
  }
});

bankAccountsRouter.post("/link-token", async (context) => {
  context.header("Cache-Control", "no-store");

  if (!isTrustedOrigin(context.req.header("origin"))) {
    return context.json({ error: "Request origin is not allowed." }, 403);
  }

  const userId: string | null = await getUserId(context);
  if (!userId) {
    return context.json({ error: "Authentication required." }, 401);
  }

  let connection;
  try {
    connection = getPlaidConnection();
  } catch (error: unknown) {
    if (error instanceof PlaidConfigurationError) {
      console.error(error.message);
      return configurationFailure(context);
    }
    throw error;
  }

  if (!connection) {
    return configurationFailure(context);
  }

  try {
    const response = await connection.client.linkTokenCreate({
      user: { client_user_id: userId },
      client_name: "Finance",
      products: [Products.Transactions],
      transactions: { days_requested: 30 },
      country_codes: [CountryCode.Us],
      language: "en",
    });

    return context.json({ linkToken: response.data.link_token });
  } catch (error: unknown) {
    logPlaidFailure("link token creation", error);
    return context.json(
      { error: "Unable to start a secure bank connection with Plaid." },
      502,
    );
  }
});

bankAccountsRouter.post("/exchange", async (context) => {
  context.header("Cache-Control", "no-store");

  if (!isTrustedOrigin(context.req.header("origin"))) {
    return context.json({ error: "Request origin is not allowed." }, 403);
  }

  const userId: string | null = await getUserId(context);
  if (!userId) {
    return context.json({ error: "Authentication required." }, 401);
  }

  let body: unknown;
  try {
    body = await context.req.json();
  } catch {
    return context.json({ error: "A valid JSON body is required." }, 400);
  }

  if (
    typeof body !== "object" ||
    body === null ||
    !("publicToken" in body) ||
    typeof body.publicToken !== "string" ||
    body.publicToken.length === 0 ||
    body.publicToken.length > 1024
  ) {
    return context.json({ error: "A valid Plaid public token is required." }, 400);
  }

  let connection;
  try {
    connection = getPlaidConnection();
  } catch (error: unknown) {
    if (error instanceof PlaidConfigurationError) {
      console.error(error.message);
      return configurationFailure(context);
    }
    throw error;
  }

  if (!connection) {
    return configurationFailure(context);
  }

  let accessToken: string | null = null;
  let itemId: string | null = null;
  let saved: boolean = false;
  let safeToRemoveUnstoredItem: boolean = false;
  try {
    const exchange = await connection.client.itemPublicTokenExchange({
      public_token: body.publicToken,
    });
    accessToken = exchange.data.access_token;
    itemId = exchange.data.item_id;

    const existing: { user_id: string } | undefined = sqliteClient
      .prepare("SELECT user_id FROM bank_item WHERE item_id = ?")
      .get(itemId) as { user_id: string } | undefined;

    if (existing && existing.user_id !== userId) {
      return context.json(
        { error: "This bank connection is already linked to another user." },
        409,
      );
    }
    safeToRemoveUnstoredItem = !existing;

    const [itemResponse, accountsResponse] = await Promise.all([
      connection.client.itemGet({ access_token: accessToken }),
      connection.client.accountsGet({ access_token: accessToken }),
    ]);
    const institutionId: string | null =
      itemResponse.data.item.institution_id ?? null;
    let institutionName: string = "Connected institution";

    if (institutionId) {
      const institutionResponse =
        await connection.client.institutionsGetById({
          institution_id: institutionId,
          country_codes: [CountryCode.Us],
        });
      institutionName =
        institutionResponse.data.institution.name;
    }

    saveAccounts(
      userId,
      itemId,
      institutionName,
      institutionId,
      encryptPlaidValue(accessToken, connection.encryptionKey),
      accountsResponse.data.accounts,
      connection.encryptionKey,
    );
    saved = true;

    return context.json({ accounts: getAccountsForUser(userId) });
  } catch (error: unknown) {
    if (!saved && safeToRemoveUnstoredItem && accessToken && itemId) {
      try {
        const existing: { user_id: string } | undefined = sqliteClient
          .prepare("SELECT user_id FROM bank_item WHERE item_id = ?")
          .get(itemId) as { user_id: string } | undefined;
        if (!existing) {
          await connection.client.itemRemove({ access_token: accessToken });
        }
      } catch (cleanupError: unknown) {
        logPlaidFailure("cleanup after failed connection", cleanupError);
      }
    }

    if (error instanceof BankItemOwnershipError) {
      return context.json(
        { error: "This bank connection is already linked to another user." },
        409,
      );
    }

    logPlaidFailure("account connection", error);
    return context.json(
      { error: "Unable to connect this bank account. Please try again." },
      502,
    );
  }
});

bankAccountsRouter.delete("/items/:itemId", async (context) => {
  context.header("Cache-Control", "no-store");

  if (!isTrustedOrigin(context.req.header("origin"))) {
    return context.json({ error: "Request origin is not allowed." }, 403);
  }

  const userId: string | null = await getUserId(context);
  if (!userId) {
    return context.json({ error: "Authentication required." }, 401);
  }

  const itemId: string = context.req.param("itemId");
  if (itemId.length === 0 || itemId.length > 256) {
    return context.json({ error: "Invalid bank connection identifier." }, 400);
  }

  const connectionRecord: BankItemRecord | undefined = sqliteClient
    .prepare(`
      SELECT
        user_id AS userId,
        encrypted_institution_name AS encryptedInstitutionName,
        item_id AS itemId,
        encrypted_access_token AS encryptedAccessToken
      FROM bank_item
      WHERE item_id = ? AND user_id = ?
    `)
    .get(itemId, userId) as BankItemRecord | undefined;

  if (!connectionRecord) {
    return context.json({ error: "Bank connection not found." }, 404);
  }

  let plaidConnection;
  try {
    plaidConnection = getPlaidConnection();
  } catch (error: unknown) {
    if (error instanceof PlaidConfigurationError) {
      console.error(error.message);
      return configurationFailure(context);
    }
    throw error;
  }

  if (!plaidConnection) {
    return configurationFailure(context);
  }

  try {
    const accessToken: string = decryptPlaidValue(
      connectionRecord.encryptedAccessToken,
      plaidConnection.encryptionKey,
    );
    await plaidConnection.client.itemRemove({ access_token: accessToken });

    sqliteClient
      .prepare("DELETE FROM bank_item WHERE item_id = ? AND user_id = ?")
      .run(itemId, userId);

    return context.body(null, 204);
  } catch (error: unknown) {
    logPlaidFailure("bank disconnection", error);
    return context.json(
      { error: "Unable to disconnect this bank right now. Please try again." },
      502,
    );
  }
});

export { bankAccountsRouter };
