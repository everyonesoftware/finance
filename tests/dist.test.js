import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import test from "node:test";
import Database from "better-sqlite3";
import {
  decryptPlaidValue,
  encryptPlaidValue,
  getPlaidErrorLogDetails,
} from "../server-dist/plaid.js";
import { applySqlMigration } from "../server-dist/migration-utils.js";
import { renderOverviewBankAccounts } from "../src/bank_accounts.ts";

const distDirectory = new URL("../dist/", import.meta.url);
const migrationsDirectory = new URL("../server/migrations/", import.meta.url);

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
  assert.match(html, /\+1 more account/);
  assert.doesNotMatch(html, /<Checking>|Bank <One>/);
  assert.match(renderOverviewBankAccounts([]), /No bank accounts connected yet/);
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
