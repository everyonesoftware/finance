import assert from "node:assert/strict";
import { access, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import {
  decryptPlaidValue,
  encryptPlaidValue,
  getPlaidErrorLogDetails,
} from "../server-dist/plaid.js";
import { listAccountTransactions, refreshBankAccountSnapshots } from "../server-dist/account-storage.js";
import { applySqlMigration } from "../server-dist/migration-utils.js";
import { collectTransactionPages, getRecentTransactions } from "../server-dist/transaction-sync.js";
import { renderDashboard } from "../src/dashboard.ts";
import {
  formatTransactionAmount,
  getTotalBalance,
  renderAccountDetail,
  renderBankAccountDetailPage,
  renderBankAccountsPage,
  renderAccounts,
  renderOverviewBankAccounts,
} from "../src/bank_accounts.ts";

const distDirectory = new URL("../dist/", import.meta.url);
const migrationsDirectory = new URL("../server/migrations/", import.meta.url);

test("transaction pagination restarts from the original cursor after mutation", async () => {
  const calls = [];
  let attempt = 0;
  const result = await collectTransactionPages(async ({ cursor }) => {
    calls.push(cursor);
    if (attempt++ === 0) return { added: [{ transaction_id: "stale" }], modified: [], removed: [], next_cursor: "page-2", has_more: true };
    if (attempt === 2) throw Object.assign(new Error("mutation"), { response: { data: { error_code: "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION" } } });
    return { added: [{ transaction_id: "fresh" }], modified: [], removed: [], next_cursor: "done", has_more: false };
  }, "saved", 3);
  assert.deepEqual(calls, ["saved", "page-2", "saved"]);
  assert.deepEqual(result.added.map((transaction) => transaction.transaction_id), ["fresh"]);
  assert.equal(result.cursor, "done");
});

test("transaction pagination safety cap fails without returning a commit cursor", async () => {
  let calls = 0;
  await assert.rejects(collectTransactionPages(async () => {
    calls++;
    return { added: [{ transaction_id: `t${calls}` }], modified: [], removed: [], next_cursor: `c${calls}`, has_more: true };
  }, "saved", 2), /page limit/);
  assert.equal(calls, 2);
});

test("recent transactions are sorted newest first and limited to 50", () => {
  const transactions = Array.from({ length: 52 }, (_, index) => ({
    transaction_id: `t${index}`,
    date: new Date(Date.UTC(2026, 0, index + 1)).toISOString().slice(0, 10),
  }));
  const recent = getRecentTransactions(transactions);
  assert.equal(recent.length, 50);
  assert.equal(recent[0].date, transactions[51].date);
  assert.equal(recent.at(-1).date, transactions[2].date);
});

test("Plaid transaction amounts render spending as negative and income as positive", () => {
  assert.equal(formatTransactionAmount(24.5, "USD"), "-$24.50");
  assert.equal(formatTransactionAmount(-125.75, "USD"), "$125.75");
  assert.equal(formatTransactionAmount(3, "CAD"), "-CA$3.00");
  assert.equal(formatTransactionAmount(3, null), "-3.00");
});

test("dashboard does not present sample income, expense, or chart data as real", () => {
  const html = renderDashboard({ displayName: "Test", username: "test" });
  assert.doesNotMatch(html, /\$5,240|\$2,180|--height:/);
  assert.match(html, /class="app-version">Version dev<\/span>/);
  assert.match(html, /Not available yet/);
  assert.match(html, /Sync transactions to see income and spending trends/);
});

test("production HTML references existing JavaScript and CSS assets", async () => {
  const html = await readFile(new URL("index.html", distDirectory), "utf8");
  const scriptPath = html.match(/src="(\/assets\/[^"]+\.js)"/)?.[1];
  const stylesheetPath = html.match(/href="(\/assets\/[^"]+\.css)"/)?.[1];

  assert.match(html, /<title>Finance/);
  assert.ok(scriptPath, "production HTML should reference a JavaScript asset");
  assert.ok(stylesheetPath, "production HTML should reference a CSS asset");

  await access(new URL(`.${scriptPath}`, distDirectory));
  await access(new URL(`.${stylesheetPath}`, distDirectory));
});

test("Plaid data encryption hides values and detects tampering", () => {
  const key = Buffer.alloc(32, 17);
  const value = "plaid-access-token";
  const encrypted = encryptPlaidValue(value, key);

  assert.notEqual(encrypted, value);
  assert.equal(decryptPlaidValue(encrypted, key), value);

  const [version, iv, authTag, ciphertext] = encrypted.split(".");
  assert.ok(version && iv && authTag && ciphertext);
  const changedCiphertext = `${ciphertext.startsWith("A") ? "B" : "A"}${ciphertext.slice(1)}`;
  const tampered = [version, iv, authTag, changedCiphertext].join(".");
  assert.throws(() => decryptPlaidValue(tampered, key));
});

test("Plaid failure logs contain diagnostics but omit sensitive response data", () => {
  const error = Object.assign(new Error("request contains a sensitive token"), {
    code: "ECONNABORTED",
    config: { headers: { "PLAID-SECRET": "secret-value" } },
    response: {
      status: 400,
      data: {
        error_type: "INVALID_REQUEST",
        error_code: "INVALID_FIELD",
        request_id: "request-123",
        error_message: "sensitive provider message",
        display_message: "sensitive display text",
      },
    },
  });

  const details = getPlaidErrorLogDetails("link token creation", error);
  const serialized = JSON.stringify(details);

  assert.deepEqual(details, {
    operation: "link token creation",
    errorName: "Error",
    plaidErrorType: "INVALID_REQUEST",
    plaidErrorCode: "INVALID_FIELD",
    requestId: "request-123",
    httpStatus: 400,
    networkCode: "ECONNABORTED",
  });
  assert.doesNotMatch(serialized, /secret-value|sensitive|PLAID-SECRET/);
});

test("overview bank-account list escapes values and links additional accounts", () => {
  const account = {
    id: "account-1",
    itemId: "item-1",
    institutionName: "Bank <One>",
    name: "<Checking>",
    officialName: null,
    type: "depository",
    subtype: "checking",
    mask: "1234",
    currentBalance: 125.5,
    availableBalance: 100,
    currencyCode: "USD",
    updatedAt: new Date().toISOString(),
  };
  const html = renderOverviewBankAccounts([
    account,
    { ...account, id: "account-2" },
    { ...account, id: "account-3" },
    { ...account, id: "account-4" },
    { ...account, id: "account-5" },
  ]);

  assert.equal((html.match(/class="account-row"/g) ?? []).length, 4);
  assert.match(html, /&lt;Checking&gt;/);
  assert.match(html, /Bank &lt;One&gt;/);
  assert.match(html, /href="\/accounts\/account-1"/);
  assert.equal((html.match(/class="overview-account-link"/g) ?? []).length, 4);
  assert.match(html, /\+1 more account/);
  assert.doesNotMatch(html, /<Checking>|Bank <One>/);
  assert.match(renderOverviewBankAccounts([]), /No bank accounts connected yet/);
});

test("overview total balance subtracts credit and loan balances", () => {
  const account = {
    id: "account-1",
    itemId: "item-1",
    institutionName: "Bank One",
    name: "Checking",
    officialName: null,
    type: "depository",
    subtype: "checking",
    mask: "1234",
    currentBalance: 125.5,
    availableBalance: 100,
    currencyCode: "USD",
    updatedAt: new Date().toISOString(),
  };

  assert.equal(
    getTotalBalance([
      account,
      { ...account, id: "account-2", currentBalance: 250.25 },
      { ...account, id: "account-3", currentBalance: null },
      { ...account, id: "account-4", type: "credit", currentBalance: 75 },
      { ...account, id: "account-5", type: "loan", currentBalance: 10 },
      { ...account, id: "account-6", type: "credit", currentBalance: -5 },
    ]),
    285.75,
  );
  assert.equal(getTotalBalance([]), 0);
});

test("accounts page renders credit and loan balances as negative and red", () => {
  const account = {
    id: "account-1",
    itemId: "item-1",
    institutionName: "Bank One",
    name: "Credit card",
    officialName: null,
    type: "credit",
    subtype: "credit card",
    mask: "1234",
    currentBalance: 75,
    availableBalance: 100,
    currencyCode: "USD",
    updatedAt: new Date().toISOString(),
  };
  const html = renderAccounts([
    account,
    { ...account, id: "account-2", type: "loan", name: "Loan", currentBalance: -125 },
    { ...account, id: "account-3", type: "depository", name: "Checking" },
  ]);

  assert.match(html, /class="connected-account-balance liability-balance">\s*-\$75\.00/);
  assert.match(html, /class="connected-account-balance liability-balance">\s*-\$125\.00/);
  assert.match(html, /class="connected-account-balance">\s*\$75\.00/);
  assert.match(html, /href="\/accounts\/account-1"/);
});

test("account detail page provides a protected-page shell and loading target", () => {
  const html = renderBankAccountDetailPage({ displayName: "<A User>", username: "finance-user" });
  assert.match(html, /id="account-detail-content"/);
  assert.match(html, /href="\/accounts"/);
  assert.match(html, /Loading account details and transactions/);
  assert.match(html, /id="sync-account-transactions"/);
  assert.match(html, /id="account-transaction-status"/);
  assert.match(html, /class="app-version">Version dev<\/span>/);
  assert.match(html, /&lt;A User&gt;/);
  assert.doesNotMatch(html, /<A User>/);

  const accountsPage = renderBankAccountsPage({ displayName: "Test User", username: "test-user" });
  assert.match(accountsPage, /class="app-version">Version dev<\/span>/);
});

test("account detail renders an account snapshot and escaped account transactions", () => {
  const account = {
    id: "account-1",
    itemId: "item-1",
    institutionName: "Bank One",
    name: "Checking",
    officialName: "Everyday Checking",
    type: "depository",
    subtype: "checking",
    mask: "1234",
    currentBalance: 250.5,
    availableBalance: 200,
    currencyCode: "USD",
    updatedAt: "2026-10-30T12:00:00.000Z",
  };
  const matchingSavings = { ...account, id: "savings-id", name: "Savings", mask: "4753" };
  const html = renderAccountDetail(account, [
    { name: "Internet transfer from Savings account XXXX4753", date: "2026-10-29", amount: 12.5, iso_currency_code: "USD" },
    { name: "Internet transfer from Savings account XXXX9999", date: "2026-10-28", amount: 2, iso_currency_code: "USD" },
    { name: "Merchant <unsafe>", date: "2026-10-27", amount: 1, iso_currency_code: "USD" },
  ], [account, matchingSavings]);
  assert.match(html, /Bank One/);
  assert.match(html, /Everyday Checking/);
  assert.match(html, /•••• 1234/);
  assert.match(html, /\$250\.50/);
  assert.match(html, /-\$12\.50/);
  assert.match(html, /href="\/accounts\/savings-id"[^>]*>Savings account XXXX4753<\/a>/);
  assert.match(html, /Savings account XXXX9999/);
  assert.doesNotMatch(html, /href="\/accounts\/account-1"[^>]*>Savings account XXXX9999/);
  assert.match(html, /Merchant &lt;unsafe&gt;/);
  assert.doesNotMatch(html, /<unsafe>/);
  assert.ok(html.indexOf("account-detail-snapshot") < html.indexOf("account-detail-transactions"));
});

test("bank-account migration creates user-owned encrypted data tables", async () => {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  const migrationNames = (await readdir(migrationsDirectory))
    .filter((name) => name.endsWith(".sql"))
    .sort();

  for (const migrationName of migrationNames) {
    applySqlMigration(
      database,
      await readFile(new URL(migrationName, migrationsDirectory), "utf8"),
    );
  }

  const tableNames = database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    )
    .all()
    .map((row) => row.name);

  assert.ok(tableNames.includes("bank_item"));
  assert.ok(tableNames.includes("bank_account"));
  assert.equal(
    database
      .prepare("PRAGMA table_info(bank_account)")
      .all()
      .some((column) => column.name === "encrypted_data"),
    true,
  );

  database
    .prepare("INSERT INTO user (id, name, email) VALUES (?, ?, ?)")
    .run("user-one", "User One", "one@example.test");
  database
    .prepare("INSERT INTO user (id, name, email) VALUES (?, ?, ?)")
    .run("user-two", "User Two", "two@example.test");
  database
    .prepare(
      "INSERT INTO bank_item (item_id, user_id, encrypted_institution_name, encrypted_access_token) VALUES (?, ?, ?, ?)",
    )
    .run("item-one", "user-one", "encrypted-name", "encrypted-token");
  database
    .prepare(
      "INSERT INTO bank_account (id, plaid_account_id, item_id, user_id, encrypted_data) VALUES (?, ?, ?, ?, ?)",
    )
    .run("account-one", "plaid-account-one", "item-one", "user-one", "encrypted-data");

  assert.throws(
    () =>
      database
        .prepare(
          "INSERT INTO bank_account (id, plaid_account_id, item_id, user_id, encrypted_data) VALUES (?, ?, ?, ?, ?)",
        )
        .run("account-two", "plaid-account-two", "item-one", "user-two", "encrypted-data"),
    /FOREIGN KEY constraint failed/,
  );
  database.close();
});

test("legacy auth table rename keeps existing rows", async () => {
  const database = new Database(":memory:");
  database.exec(`
    CREATE TABLE "account" ("id" text PRIMARY KEY);
    CREATE TABLE "verification" ("id" text PRIMARY KEY);
  `);
  database
    .prepare("INSERT INTO account (id) VALUES (?)")
    .run("existing-account");
  database
    .prepare("INSERT INTO verification (id) VALUES (?)")
    .run("existing-verification");

  applySqlMigration(
    database,
    await readFile(
      new URL(
        "0003_rename_legacy_auth_tables.sql",
        migrationsDirectory,
      ),
      "utf8",
    ),
  );

  assert.equal(
    database
      .prepare("SELECT id FROM user_account")
      .get().id,
    "existing-account",
  );
  assert.equal(
    database
      .prepare("SELECT id FROM user_verification")
      .get().id,
    "existing-verification",
  );
  database.close();
});


test("account refresh preserves historical account IDs while hiding inactive accounts", async () => {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  const migrationNames = (await readdir(migrationsDirectory))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const migrationName of migrationNames) {
    applySqlMigration(database, await readFile(new URL(migrationName, migrationsDirectory), "utf8"));
  }
  database.prepare("INSERT INTO user (id, name, email) VALUES (?, ?, ?)")
    .run("user-one", "User One", "one@example.test");
  database.prepare("INSERT INTO bank_item (item_id, user_id, encrypted_institution_name, encrypted_access_token) VALUES (?, ?, ?, ?)")
    .run("item-one", "user-one", "encrypted-name", "encrypted-token");

  refreshBankAccountSnapshots(database, "item-one", "user-one", [
    { plaidAccountId: "plaid-account-one", encryptedData: "encrypted-v1" },
  ]);
  const original = database.prepare("SELECT id FROM bank_account WHERE item_id = ?")
    .get("item-one");
  refreshBankAccountSnapshots(database, "item-one", "user-one", []);
  const inactive = database.prepare("SELECT id, is_active FROM bank_account WHERE item_id = ?")
    .get("item-one");
  assert.equal(inactive.id, original.id);
  assert.equal(inactive.is_active, 0);

  refreshBankAccountSnapshots(database, "item-one", "user-one", [
    { plaidAccountId: "plaid-account-one", encryptedData: "encrypted-v2" },
  ]);
  const reactivated = database.prepare("SELECT id, is_active, encrypted_data FROM bank_account WHERE item_id = ?")
    .get("item-one");
  assert.equal(reactivated.id, original.id);
  assert.equal(reactivated.is_active, 1);
  assert.equal(reactivated.encrypted_data, "encrypted-v2");
  database.close();
});

test("account transaction queries are scoped to the owning user, item, and account", async () => {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  const migrationNames = (await readdir(migrationsDirectory))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const migrationName of migrationNames) {
    applySqlMigration(database, await readFile(new URL(migrationName, migrationsDirectory), "utf8"));
  }
  database.prepare("INSERT INTO user (id, name, email) VALUES (?, ?, ?)")
    .run("user-one", "User One", "one@example.test");
  database.prepare("INSERT INTO user (id, name, email) VALUES (?, ?, ?)")
    .run("user-two", "User Two", "two@example.test");
  const insertItem = database.prepare("INSERT INTO bank_item (item_id, user_id, encrypted_institution_name, encrypted_access_token) VALUES (?, ?, ?, ?)");
  insertItem.run("item-one", "user-one", "encrypted-name", "encrypted-token");
  insertItem.run("item-two", "user-two", "encrypted-name", "encrypted-token");
  const key = Buffer.alloc(32, 23);
  const insertTransaction = database.prepare("INSERT INTO bank_transaction (transaction_id, item_id, user_id, account_id, encrypted_data) VALUES (?, ?, ?, ?, ?)");
  const encode = (name, date) => encryptPlaidValue(JSON.stringify({ name, date }), key);
  insertTransaction.run("tx-one", "item-one", "user-one", "account-one", encode("Target account transaction", "2026-10-29"));
  insertTransaction.run("tx-two", "item-one", "user-one", "account-two", encode("Another account transaction", "2026-10-30"));
  insertTransaction.run("tx-three", "item-two", "user-two", "account-one", encode("Another user transaction", "2026-10-30"));

  const transactions = listAccountTransactions(database, "user-one", "item-one", "account-one", key);
  assert.deepEqual(transactions.map((transaction) => transaction.name), ["Target account transaction"]);
  database.close();
});

test("transaction migration stores encrypted transaction records and protected sync cursors", async () => {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  const migrationNames = (await readdir(migrationsDirectory))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const migrationName of migrationNames) {
    applySqlMigration(database, await readFile(new URL(migrationName, migrationsDirectory), "utf8"));
  }
  const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name);
  assert.ok(tables.includes("bank_transaction"));
  const columns = database.prepare("PRAGMA table_info(bank_item)").all().map((column) => column.name);
  assert.ok(columns.includes("encrypted_transaction_cursor"));
  const transactionColumns = database.prepare("PRAGMA table_info(bank_transaction)").all().map((column) => column.name);
  assert.ok(transactionColumns.includes("encrypted_data"));

  database.prepare("INSERT INTO user (id, name, email) VALUES (?, ?, ?)")
    .run("user-one", "User One", "one@example.test");
  database.prepare("INSERT INTO user (id, name, email) VALUES (?, ?, ?)")
    .run("user-two", "User Two", "two@example.test");
  database.prepare("INSERT INTO bank_item (item_id, user_id, encrypted_institution_name, encrypted_access_token) VALUES (?, ?, ?, ?)")
    .run("item-one", "user-one", "encrypted-name", "encrypted-token");
  database.prepare("INSERT INTO bank_transaction (transaction_id, item_id, user_id, account_id, encrypted_data) VALUES (?, ?, ?, ?, ?)")
    .run("tx-one", "item-one", "user-one", "account-one", "encrypted-payload");
  assert.throws(
    () => database.prepare("INSERT INTO bank_transaction (transaction_id, item_id, user_id, account_id, encrypted_data) VALUES (?, ?, ?, ?, ?)")
      .run("tx-two", "item-one", "user-two", "account-two", "encrypted-payload"),
    /FOREIGN KEY constraint failed/,
  );
  const wrongOwnerDelete = database.prepare("DELETE FROM bank_transaction WHERE item_id = ? AND transaction_id = ? AND user_id = ?")
    .run("item-one", "tx-one", "user-two");
  assert.equal(wrongOwnerDelete.changes, 0);
  assert.equal(database.prepare("SELECT user_id FROM bank_transaction WHERE item_id = ? AND transaction_id = ?")
    .get("item-one", "tx-one").user_id, "user-one");
  database.close();
});

test("account transaction endpoint requires an authenticated session", async () => {
  const temporaryDirectory = await mkdtemp(join(process.env["TMPDIR"] ?? process.cwd(), "finance-route-test-"));
  const originalEnvironment = {
    DATABASE_PATH: process.env["DATABASE_PATH"],
    BETTER_AUTH_SECRET: process.env["BETTER_AUTH_SECRET"],
    ORIGIN_URL: process.env["ORIGIN_URL"],
  };
  process.env["DATABASE_PATH"] = join(temporaryDirectory, "finance.sqlite");
  process.env["BETTER_AUTH_SECRET"] = "test-only-auth-secret-at-least-32-characters-long";
  process.env["ORIGIN_URL"] = "http://localhost:5173";
  let closeDatabase;

  try {
    const databaseModule = await import("../server-dist/database.js");
    const { bankAccountsRouter } = await import("../server-dist/bank_accounts.js");
    closeDatabase = databaseModule.closeDatabase;
    await databaseModule.runMigrations();
    const response = await bankAccountsRouter.request("/account-one/transactions");
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
  } finally {
    await closeDatabase?.();
    for (const [name, value] of Object.entries(originalEnvironment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});
