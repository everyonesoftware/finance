import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import test from "node:test";
import Database from "better-sqlite3";
import { decryptBankValue, encryptBankValue } from "../server-dist/bank-crypto.js";

import { applySqlMigration } from "../server-dist/migration-utils.js";
import { collectTransactionPages, getRecentTransactions } from "../server-dist/transaction-sync.js";
import { groupInternalTransfers, renderTransactionList } from "../src/transaction-list.ts";
import { filterAndSortTransactionGroups } from "../src/transaction-filters.ts";
import * as transactionFilterUtils from "../src/transaction-filters.ts";
import { renderRealEstateCards } from "../src/real-estate.ts";
import { parseZillowZestimate, fetchZillowZestimate } from "../server-dist/zillow.js";
import { renderTransactionsPage, getTransactionAmountBounds, formatFilterAmount } from "../src/transactions-page.ts";
import { renderDashboard } from "../src/dashboard.ts";
import { renderMainNavigation } from "../src/navigation.ts";
import {
  formatTransactionAmount,
  getTotalBalance,
  renderAccountDetail,
  renderBankAccountDetailPage,
  renderBankAccountsPage,
  renderConnections,
  renderConnectionsPage,
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

test("internal transfers with reciprocal connected-account references collapse into one expandable pair", () => {
  const accounts = [
    { id: "checking-id", providerAccountId: "provider-checking", itemId: "item-a", name: "Checking", officialName: null, institutionName: "Bank", type: "depository", subtype: "checking", mask: "1257", currentBalance: 100, availableBalance: 100, currencyCode: "USD", updatedAt: "2026-10-30" },
    { id: "savings-id", providerAccountId: "provider-savings", itemId: "item-a", name: "Everyday Savings", officialName: null, institutionName: "Bank", type: "depository", subtype: "savings", mask: "4753", currentBalance: 200, availableBalance: 200, currencyCode: "USD", updatedAt: "2026-10-30" },
  ];
  const transactions = [
    { transaction_id: "out", account_id: "provider-checking", name: "Internet transfer to Savings account XXXXXX4753", date: "2026-10-29", amount: 50, iso_currency_code: "USD" },
    { transaction_id: "in", account_id: "provider-savings", name: "Internet transfer from Savings account XXXXXX1257", date: "2026-10-29", amount: -50, iso_currency_code: "USD" },
    { transaction_id: "groceries", account_id: "provider-checking", name: "Grocery store", date: "2026-10-28", amount: 22, iso_currency_code: "USD" },
  ];

  const groups = groupInternalTransfers(transactions, accounts);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].type, "transfer");
  assert.deepEqual(groups[0].transactions.map((transaction) => transaction.transaction_id), ["out", "in"]);
  assert.equal(groups[1].type, "single");

  const html = renderTransactionList(transactions, accounts);
  assert.match(html, /<details class="transaction-transfer-pair">/);
  assert.match(html, /class="transaction-copy transfer-pair-copy">\s*<strong>Transfer: Checking → Everyday Savings<\/strong>\s*<span>2026-10-29<\/span>/);
  assert.match(html, /class="transfer-pair-amount">\$50\.00/);
  assert.doesNotMatch(html, /transfer-pair-toggle|transfer-pair-collapsed|transfer-pair-expanded/);
  assert.match(html, /aria-label="Expand or collapse original transfer transactions"/);
  assert.match(html, /class="transfer-pair-details-label">Transactions included in this transfer<\/div>/);
  assert.match(html, /href="\/accounts\/savings-id"/);
  assert.match(html, /href="\/accounts\/checking-id">Savings account XXXXXX1257<\/a>/);
  assert.match(html, /Internet transfer to/);
});

test("transaction filters include, exclude, and sort grouped transactions by amount and date", () => {
  const checking = { id: "checking-id", providerAccountId: "provider-checking", name: "Checking" };
  const savings = { id: "savings-id", providerAccountId: "provider-savings", name: "Savings" };
  const groups = [
    { type: "single", transactions: [{ transaction_id: "checking-five", account_id: "provider-checking", amount: -5, date: "2026-10-28" }] },
    { type: "single", transactions: [{ transaction_id: "savings-ten", account_id: "provider-savings", amount: 10, date: "2026-10-30" }] },
    {
      type: "transfer",
      transactions: [
        { transaction_id: "transfer-out", account_id: "provider-checking", amount: 20, date: "2026-10-29" },
        { transaction_id: "transfer-in", account_id: "provider-savings", amount: -20, date: "2026-10-29" },
      ],
      fromAccount: checking,
      toAccount: savings,
    },
  ];
  const sharedFilters = {
    includeAccountIds: [],
    excludeAccountIds: [],
    minimumAmount: -20,
    maximumAmount: 20,
  };

  const included = filterAndSortTransactionGroups(groups, [checking, savings], {
    ...sharedFilters,
    includeAccountIds: ["checking-id"],
    sort: "amount-desc",
  });
  assert.deepEqual(included.map((group) => group.transactions[0].transaction_id), ["transfer-out", "checking-five"]);

  const multiIncluded = filterAndSortTransactionGroups(groups, [checking, savings], {
    ...sharedFilters,
    includeAccountIds: ["checking-id", "savings-id"],
    sort: "amount-desc",
  });
  assert.deepEqual(multiIncluded.map((group) => group.transactions[0].transaction_id), ["transfer-out", "checking-five", "savings-ten"]);

  const noneSelected = filterAndSortTransactionGroups(groups, [checking, savings], {
    ...sharedFilters,
    sort: "date-desc",
  });
  assert.deepEqual(noneSelected, []);

  const amountRange = filterAndSortTransactionGroups(groups, [checking, savings], {
    ...sharedFilters,
    includeAccountIds: ["checking-id", "savings-id"],
    minimumAmount: -15,
    maximumAmount: -5,
    sort: "amount-asc",
  });
  assert.deepEqual(amountRange.map((group) => group.transactions[0].transaction_id), ["savings-ten"]);

  const excluded = filterAndSortTransactionGroups(groups, [checking, savings], {
    ...sharedFilters,
    includeAccountIds: ["checking-id", "savings-id"],
    excludeAccountIds: ["savings-id"],
    sort: "date-desc",
  });
  assert.deepEqual(excluded.map((group) => group.transactions[0].transaction_id), ["checking-five"]);

  const byDate = filterAndSortTransactionGroups(groups, [checking, savings], {
    ...sharedFilters,
    includeAccountIds: ["checking-id", "savings-id"],
    sort: "date-desc",
  });
  assert.deepEqual(byDate.map((group) => group.transactions[0].transaction_id), ["savings-ten", "transfer-out", "checking-five"]);
});

test("account selection defaults to all on first load and preserves choices on refresh", () => {
  const getAccountSelectionOnLoad = transactionFilterUtils.getAccountSelectionOnLoad;
  assert.equal(typeof getAccountSelectionOnLoad, "function");
  const currentAccountIds = ["checking-id", "savings-id", "investment-id"];
  assert.deepEqual(getAccountSelectionOnLoad(currentAccountIds, null, []), currentAccountIds);
  assert.deepEqual(getAccountSelectionOnLoad(currentAccountIds, ["checking-id", "savings-id"], []), []);
  assert.deepEqual(getAccountSelectionOnLoad(currentAccountIds, ["checking-id", "savings-id"], ["savings-id"]), ["savings-id"]);
  assert.deepEqual(
    getAccountSelectionOnLoad(currentAccountIds, ["checking-id", "savings-id"], ["checking-id", "savings-id"]),
    currentAccountIds,
  );
});

test("bulk account selection changes only filtered accounts and preserves other selections", () => {
  const updateSelectedAccountIds = transactionFilterUtils.updateSelectedAccountIds;
  assert.equal(typeof updateSelectedAccountIds, "function");
  const current = ["outside-filter", "already-selected"];
  assert.deepEqual(
    updateSelectedAccountIds(current, ["already-selected", "new-match"], true),
    ["outside-filter", "already-selected", "new-match"],
  );
  assert.deepEqual(updateSelectedAccountIds(current, ["already-selected"], false), ["outside-filter"]);
  assert.deepEqual(updateSelectedAccountIds(current, [], false), current);
});

test("account search matches fuzzy subsequences and highlights only matched characters", () => {
  const getFuzzyMatchPositions = transactionFilterUtils.getFuzzyMatchPositions;
  const renderFuzzyHighlightedText = transactionFilterUtils.renderFuzzyHighlightedText;
  assert.equal(typeof getFuzzyMatchPositions, "function");
  assert.equal(typeof renderFuzzyHighlightedText, "function");
  const label = "Ally · Checking · •••• 1234";
  const positions = getFuzzyMatchPositions("Ally Chk", label);
  assert.deepEqual(positions, [0, 1, 2, 3, 7, 8, 11]);
  assert.equal(
    renderFuzzyHighlightedText(label, positions),
    "<mark>Ally</mark> · <mark>Ch</mark>ec<mark>k</mark>ing · •••• 1234",
  );
  assert.equal(getFuzzyMatchPositions("zzz", label), null);
  assert.deepEqual(getFuzzyMatchPositions("", label), []);
  assert.equal(renderFuzzyHighlightedText("<Ally>", [1, 2, 3, 4]), "&lt;<mark>Ally</mark>&gt;");
});

test("transaction lists can show the owning institution and account for each row", () => {
  const account = {
    id: "checking-id",
    providerAccountId: "provider-checking",
    institutionName: "Ally Bank",
    name: "Checking",
  };
  const html = renderTransactionList([
    { transaction_id: "coffee", account_id: "provider-checking", name: "Coffee shop", date: "2026-10-30", amount: 4.5, iso_currency_code: "USD" },
  ], [account], { showAccount: true });
  assert.match(html, /class="transaction-account-label">Ally Bank · Checking<\/span>/);
});

test("Fidelity ACH deposits referencing a connected brokerage account are grouped as transfers", () => {
  const accounts = [
    { id: "fidelity-id", providerAccountId: "provider-fidelity", itemId: "item-a", name: "Brokerage", officialName: "Individual Brokerage", institutionName: "Fidelity Investments", type: "investment", subtype: "brokerage", mask: "1283", currentBalance: 1000, availableBalance: null, currencyCode: "USD", updatedAt: "2026-10-30" },
    { id: "spending-id", providerAccountId: "provider-spending", itemId: "item-b", name: "Spending", officialName: null, institutionName: "Bank", type: "depository", subtype: "checking", mask: "5566", currentBalance: 200, availableBalance: 200, currencyCode: "USD", updatedAt: "2026-10-30" },
  ];
  const transaction = {
    transaction_id: "fidelity-ach",
    account_id: "provider-spending",
    name: "X77621283 708XN FID BKG SVC LLC ACH",
    date: "2026-10-29",
    amount: -400,
    iso_currency_code: "USD",
  };

  const groups = groupInternalTransfers([transaction], accounts);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].type, "transfer");
  if (groups[0].type !== "transfer") return;
  assert.equal(groups[0].transactions.length, 1);
  assert.equal(groups[0].fromAccount.id, "fidelity-id");
  assert.equal(groups[0].toAccount.id, "spending-id");

  const html = renderTransactionList([transaction], accounts);
  assert.match(html, /Transfer: Brokerage → Spending/);
  assert.match(html, /class="transfer-pair-amount">\$400\.00/);
  assert.match(html, /<a class="transaction-account-link" href="\/accounts\/fidelity-id">X77621283<\/a> 708XN FID BKG SVC LLC ACH/);
});

test("Fidelity ACH transfer detection requires an incoming transaction and matching connected Fidelity mask", () => {
  const accounts = [
    { id: "fidelity-id", providerAccountId: "provider-fidelity", itemId: "item-a", name: "Brokerage", officialName: null, institutionName: "Fidelity Investments", type: "investment", subtype: "brokerage", mask: "1283", currentBalance: 1000, availableBalance: null, currencyCode: "USD", updatedAt: "2026-10-30" },
    { id: "spending-id", providerAccountId: "provider-spending", itemId: "item-b", name: "Spending", officialName: null, institutionName: "Bank", type: "depository", subtype: "checking", mask: "5566", currentBalance: 200, availableBalance: 200, currencyCode: "USD", updatedAt: "2026-10-30" },
  ];
  const transaction = { account_id: "provider-spending", name: "X77621283 708XN FID BKG SVC LLC ACH", date: "2026-10-29", amount: -400, iso_currency_code: "USD" };
  const mismatches = [
    { ...transaction, amount: 400 },
    { ...transaction, name: "X77629999 708XN FID BKG SVC LLC ACH" },
    { ...transaction, name: "X77621283 708XN GENERIC ACH" },
  ];
  for (const mismatch of mismatches) {
    assert.equal(groupInternalTransfers([mismatch], accounts)[0]?.type, "single");
  }
});

test("transactions remain separate unless amount, direction, date, currency, and reciprocal accounts match", () => {
  const accounts = [
    { id: "checking-id", providerAccountId: "provider-checking", itemId: "item-a", name: "Checking", officialName: null, institutionName: "Bank", type: "depository", subtype: "checking", mask: "1257", currentBalance: 100, availableBalance: 100, currencyCode: "USD", updatedAt: "2026-10-30" },
    { id: "savings-id", providerAccountId: "provider-savings", itemId: "item-a", name: "Savings", officialName: null, institutionName: "Bank", type: "depository", subtype: "savings", mask: "4753", currentBalance: 200, availableBalance: 200, currencyCode: "USD", updatedAt: "2026-10-30" },
  ];
  const outgoing = { transaction_id: "out", account_id: "provider-checking", name: "Transfer to Savings account XXXX4753", date: "2026-10-29", amount: 50, iso_currency_code: "USD" };
  const incoming = { transaction_id: "in", account_id: "provider-savings", name: "Transfer from Checking account XXXX1257", date: "2026-10-29", amount: -50, iso_currency_code: "USD" };
  const mismatches = [
    { ...incoming, amount: -49 },
    { ...incoming, name: "Transfer to Checking account XXXX1257" },
    { ...incoming, date: "2026-11-03" },
    { ...incoming, iso_currency_code: "CAD" },
    { ...incoming, name: "Transfer from Checking account XXXX9999" },
  ];
  for (const mismatch of mismatches) {
    const groups = groupInternalTransfers([outgoing, mismatch], accounts);
    assert.equal(groups.every((group) => group.type === "single"), true);
  }
});

test("normalized transaction amounts render spending as negative and income as positive", () => {
  assert.equal(formatTransactionAmount(24.5, "USD"), "-$24.50");
  assert.equal(formatTransactionAmount(-125.75, "USD"), "$125.75");
  assert.equal(formatTransactionAmount(3, "CAD"), "-CA$3.00");
  assert.equal(formatTransactionAmount(3, null), "-3.00");
});

test("dashboard shows only implemented account and transaction features", () => {
  const html = renderDashboard({ displayName: "Test", username: "test" });
  assert.match(html, /id="overview-total-balance"/);
  assert.match(html, /id="overview-bank-accounts"/);
  assert.match(html, /id="transaction-list"/);
  assert.match(html, /id="sync-transactions"/);
  assert.ok(html.includes('href="/transactions"'));
  assert.doesNotMatch(html, /Not available yet|Spending overview|chart-placeholder|Budgets|View all transactions/);
  assert.match(html, /class="app-version">Version dev<\/span>/);
});

test("main navigation has an accessible mobile menu toggle on every finance page", () => {
  const pages = [
    renderDashboard({ displayName: "Test", username: "test" }),
    renderTransactionsPage({ displayName: "Test", username: "test" }),
    renderBankAccountsPage({ displayName: "Test", username: "test" }),
    renderBankAccountDetailPage({ displayName: "Test", username: "test" }),
    renderConnectionsPage({ displayName: "Test", username: "test" }),
  ];
  for (const html of pages) {
    assert.match(html, /class="mobile-menu-toggle"[^>]*aria-expanded="false"[^>]*aria-controls="main-navigation"/);
    assert.match(html, /class="mobile-menu-panel"/);
    assert.match(html, /<nav class="navigation" id="main-navigation">/);
    assert.match(html, /href="\/real-estate"[^>]*>[^<]*<span class="nav-icon"[^>]*>⌂<\/span> Real Estate/);
  }
});

test("every finance page renders the same navigation destinations in the same order", () => {
  const pages = [
    renderDashboard({ displayName: "Test", username: "test" }),
    renderTransactionsPage({ displayName: "Test", username: "test" }),
    renderBankAccountsPage({ displayName: "Test", username: "test" }),
    renderBankAccountDetailPage({ displayName: "Test", username: "test" }),
    renderConnectionsPage({ displayName: "Test", username: "test" }),
    renderMainNavigation("settings"),
  ];
  const destinations = pages.map((html) => {
    const navigation = html.match(/<nav class="navigation" id="main-navigation">([\s\S]*?)<\/nav>/)?.[1] ?? "";
    return [...navigation.matchAll(/href="([^"]+)"/g)].map((match) => match[1]);
  });
  assert.ok(destinations.every((links) => JSON.stringify(links) === JSON.stringify(destinations[0])));
  assert.deepEqual(destinations[0], ["/dashboard", "/transactions", "/real-estate", "/accounts", "/settings"]);
  for (const [index, html] of pages.entries()) {
    const activeHref = html.match(/<a class="nav-link active" href="([^"]+)"[^>]*aria-current="page"/)?.[1];
    assert.equal(activeHref, ["/dashboard", "/transactions", "/accounts", "/accounts", "/real-estate", "/settings"][index]);
  }
});

test("mobile menu toggle is hidden on desktop and shown at mobile widths", async () => {
  const stylesheet = await readFile(new URL("../src/style.css", import.meta.url), "utf8");
  assert.match(stylesheet, /\.mobile-menu-toggle\s*\{\s*display:\s*none;/);
  assert.match(stylesheet, /@media\s*\(max-width:\s*800px\)[\s\S]*?\.mobile-menu-toggle\s*\{\s*display:\s*grid;/);
});

test("amount range input accepts complete decimals and ignores incomplete edits", () => {
  const parseAmountRangeInput = transactionFilterUtils.parseAmountRangeInput;
  assert.equal(typeof parseAmountRangeInput, "function");
  assert.equal(parseAmountRangeInput("1."), 1);
  assert.equal(parseAmountRangeInput(".25"), 0.25);
  assert.equal(parseAmountRangeInput("-4.50"), -4.5);
  assert.equal(parseAmountRangeInput("-"), null);
  assert.equal(parseAmountRangeInput(""), null);
  const reconcileAmountRangeInput = transactionFilterUtils.reconcileAmountRangeInput;
  assert.equal(typeof reconcileAmountRangeInput, "function");
  assert.equal(reconcileAmountRangeInput("1.", 1), "1.");
  assert.equal(reconcileAmountRangeInput("1.234", 1.23), "1.23");
  assert.equal(reconcileAmountRangeInput("99", 4.5), "4.5");
});

test("amount range stays within refreshed transaction bounds", () => {
  const clampTransactionAmountRange = transactionFilterUtils.clampTransactionAmountRange;
  assert.equal(typeof clampTransactionAmountRange, "function");
  assert.deepEqual(clampTransactionAmountRange(-4, 8, -10, 10), { minimum: -4, maximum: 8 });
  assert.deepEqual(clampTransactionAmountRange(-12, -8, -5, 5), { minimum: -5, maximum: -5 });
  assert.deepEqual(clampTransactionAmountRange(8, 12, -5, 5), { minimum: 5, maximum: 5 });
});

test("amount range handles cannot cross and text-entry updates the opposite bound", () => {
  const updateTransactionAmountRange = transactionFilterUtils.updateTransactionAmountRange;
  assert.equal(typeof updateTransactionAmountRange, "function");
  assert.deepEqual(updateTransactionAmountRange(-10, 5, "minimum", 8, -10, 10), { minimum: 8, maximum: 8 });
  assert.deepEqual(updateTransactionAmountRange(0, 8, "maximum", -3, -10, 10), { minimum: -3, maximum: -3 });
  assert.deepEqual(updateTransactionAmountRange(-5, 5, "minimum", 99, -10, 10), { minimum: 10, maximum: 10 });
});

test("transactions page keeps compact account and amount popovers with sort controls", () => {
  const html = renderTransactionsPage({ displayName: "Test", username: "test" });
  assert.ok(html.includes('class="nav-link active" href="/transactions" aria-current="page"'));
  assert.match(html, /class="transaction-filter-label"[^>]*>Filter<\/span>/);
  assert.match(html, /id="accounts-filter-trigger"[^>]*>\s*Accounts: <span id="accounts-filter-selected">0<\/span> \/ <span id="accounts-filter-total">0<\/span> selected/);
  assert.match(html, /id="accounts-filter-popover"[^>]*hidden/);
  assert.doesNotMatch(html, /id="account-filter-mode"/);
  assert.match(html, /id="select-all-accounts"/);
  assert.match(html, /id="deselect-all-accounts"/);
  assert.match(html, /id="account-filter-search" type="search"/);
  assert.match(html, /id="account-options"/);
  assert.match(html, /id="amount-filter-trigger"/);
  assert.match(html, /id="amount-filter-popover"[^>]*hidden/);
  assert.match(html, /class="transaction-amount-reset-row">\s*<button id="reset-amount-filter"[^>]*>Reset<\/button>/);
  assert.ok(html.indexOf('class="transaction-amount-reset-row"') < html.indexOf('id="transaction-amount-range"'));
  assert.equal(formatFilterAmount(-1234.5), "-$1,234.50");
  assert.equal(formatFilterAmount(25), "$25.00");
  assert.match(html, /id="minimum-transaction-amount-slider"[^>]*role="slider"/);
  assert.match(html, /id="maximum-transaction-amount-slider"[^>]*role="slider"/);
  assert.match(html, /id="minimum-transaction-amount" type="text" inputmode="decimal"/);
  assert.match(html, /id="maximum-transaction-amount" type="text" inputmode="decimal"/);
  for (const value of ["date-desc", "date-asc", "amount-desc", "amount-asc"]) {
    assert.ok(html.includes(`value="${value}"`));
  }
});

test("amount bounds handle large histories without exceeding argument limits", () => {
  const amounts = Array.from({ length: 150_000 }, (_, index) => index - 75_000);
  assert.deepEqual(getTransactionAmountBounds(amounts), { minimum: -75_000, maximum: 74_999 });
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

test("bank data encryption hides values and detects tampering", () => {
  const key = Buffer.alloc(32, 17);
  const value = "provider-access-token";
  const encrypted = encryptBankValue(value, key);

  assert.notEqual(encrypted, value);
  assert.equal(decryptBankValue(encrypted, key), value);

  const [version, iv, authTag, ciphertext] = encrypted.split(".");
  assert.ok(version && iv && authTag && ciphertext);
  const changedCiphertext = `${ciphertext.startsWith("A") ? "B" : "A"}${ciphertext.slice(1)}`;
  const tampered = [version, iv, authTag, changedCiphertext].join(".");
  assert.throws(() => decryptBankValue(tampered, key));
});

test("bank encryption rejects unsupported and malformed envelopes", () => {
  const key = Buffer.alloc(32, 17);
  for (const value of ["legacy-value", "v99.a.b.c", "v1...", "", "v1.a.b.c.extra"]) {
    assert.throws(() => decryptBankValue(value, key));
  }
});

test("bank encryption preserves structured financial payloads and Unicode", () => {
  const key = Buffer.alloc(32, 17);
  const payload = JSON.stringify({ name: "Épargne 日本", amount: -12.34, pending: false, account: null });
  assert.equal(decryptBankValue(encryptBankValue(payload, key), key), payload);
});

test("bank encryption rejects a different user's encryption key", () => {
  const encrypted = encryptBankValue("provider-access-token", Buffer.alloc(32, 17));
  assert.throws(() => decryptBankValue(encrypted, Buffer.alloc(32, 18)));
});

test("bank encryption randomizes repeated values without leaking plaintext", () => {
  const key = Buffer.alloc(32, 17);
  const secret = "sensitive-provider-access-token";
  const first = encryptBankValue(secret, key);
  const second = encryptBankValue(secret, key);
  assert.notEqual(first, second);
  assert.equal(first.includes(secret), false);
  assert.equal(second.includes(secret), false);
  assert.equal(decryptBankValue(first, key), secret);
  assert.equal(decryptBankValue(second, key), secret);
});

test("bank encryption authenticates initialization vector and authentication tag", () => {
  const key = Buffer.alloc(32, 17);
  const encrypted = encryptBankValue("provider-access-token", key);
  for (const index of [1, 2]) {
    const parts = encrypted.split(".");
    const bytes = Buffer.from(parts[index], "base64");
    bytes[0] ^= 1;
    parts[index] = bytes.toString("base64");
    assert.throws(() => decryptBankValue(parts.join("."), key));
  }
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

test("institution cards provide a sync action and hide disconnect in the overflow menu", () => {
  const account = {
    id: "account-1",
    itemId: "item-1",
    institutionName: "Bank One",
    name: "Checking",
    officialName: null,
    type: "depository",
    subtype: "checking",
    mask: "1234",
    currentBalance: 75,
    availableBalance: 100,
    currencyCode: "USD",
    updatedAt: "2025-01-05T12:00:00.000Z",
    lastRetrievedAt: "2026-10-31T12:00:00.000Z",
  };
  const html = renderAccounts([account]);
  const syncIndex = html.indexOf("sync-institution-button");
  const menuIndex = html.indexOf('class="institution-actions-menu"');
  const disconnectIndex = html.indexOf("disconnect-bank");

  assert.ok(syncIndex >= 0, "institution sync button should be rendered");
  assert.ok(menuIndex > syncIndex, "overflow menu should follow the sync button");
  assert.ok(disconnectIndex > menuIndex, "disconnect action should be inside the overflow menu");
  assert.match(html, /aria-label="Synchronize Bank One"/);
  assert.match(html, /aria-label="More actions for Bank One"/);
  assert.match(html, /class="institution-last-retrieved">Last retrieved Oct 31, 2026/);
  assert.ok(html.indexOf("institution-last-retrieved") < syncIndex);
  assert.doesNotMatch(html, /institution-updated|Jan 5, 2025/);
  assert.match(html, /data-item-id="item-1"/);
});

test("real-estate page loads only property cards and excludes bank connection UI", () => {
  const account = {
    id: "account-1", itemId: "item-1", institutionName: "Bank One",
    name: "Checking", officialName: null, type: "depository", subtype: "checking",
    mask: "1234", currentBalance: 75, availableBalance: 100, currencyCode: "USD",
    updatedAt: "2026-10-31T12:00:00.000Z", lastRetrievedAt: "2026-10-31T12:00:00.000Z",
  };
  const html = renderConnections([{ itemId: "item-1", institutionName: "Bank One", lastRetrievedAt: account.lastRetrievedAt, accountCount: 2, accounts: [account, { ...account, id: "account-2", name: "Savings" }] }]);
  assert.equal((html.match(/class="connection-card"/g) ?? []).length, 1);
  assert.match(html, /<details class="connection-card">/);
  assert.match(html, /<summary class="connection-heading"/);
  assert.match(html, /Bank One/);
  assert.match(html, /2 accounts/);
  assert.match(html, /Checking/);
  assert.match(html, /Savings/);
  assert.match(renderConnections([]), /No Teller connections yet/);
  const page = renderConnectionsPage({ displayName: "Test", username: "test" });
  assert.match(page, /class="nav-link active" href="\/real-estate" aria-current="page"/);
  assert.match(page, /id="real-estate-properties"/);
  assert.match(page, /id="add-property"/);
  assert.doesNotMatch(page, /api\/accounts|choose-teller|connection-choices/);
});

test("Zillow Zestimate parser reads only the home Zestimate from the Open Graph description", () => {
  const html = `<meta property="og:description" content="15209 78th Ave NE, Kenmore WA, is a Single Family home.\n\nThe Zestimate for this Single Family is $795,900.The Rent Zestimate for this Single Family is $3,757/mo.">`;
  assert.equal(parseZillowZestimate(html), 795900);
});

test("Zillow Zestimate parser handles HTML entities and ignores rent-only estimates", () => {
  assert.equal(parseZillowZestimate(`<meta property="og:description" content="The Zestimate for this home is $1,234,500.">`), 1234500);
  assert.equal(parseZillowZestimate(`<meta property="og:description" content="The Rent Zestimate for this home is $3,757/mo.">`), null);
  assert.equal(parseZillowZestimate(`<meta property="og:description" content="No home valuation is available.">`), null);
});

test("Zillow page fetch accepts only HTTPS home-details URLs on Zillow", async () => {
  let fetchCount = 0;
  const fakeFetch = async () => {
    fetchCount++;
    return new Response(`<meta property="og:description" content="The Zestimate is $795,900. The Rent Zestimate is $3,757/mo.">`, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  };
  assert.equal(await fetchZillowZestimate("https://www.zillow.com/homedetails/example/123_zpid/", fakeFetch), 795900);
  await assert.rejects(fetchZillowZestimate("https://example.com/homedetails/example", fakeFetch), /Only HTTPS Zillow/);
  await assert.rejects(fetchZillowZestimate("http://www.zillow.com/homedetails/example", fakeFetch), /Only HTTPS Zillow/);
  await assert.rejects(fetchZillowZestimate("https://www.zillow.com/search/", fakeFetch), /Only HTTPS Zillow/);
  assert.equal(fetchCount, 1);
});

test("property cards render a delete menu and the real-estate page omits the old shared dialog", () => {
  const bank = renderConnections([{ itemId: "item-delete", institutionName: "Bank Delete", lastRetrievedAt: "2026-10-31T12:00:00.000Z", accountCount: 0, accounts: [] }]);
  const estate = renderRealEstateCards([{ id: "home-delete", address: "42 Main Street", latitude: 47, longitude: -122, estimates: [] }]);
  for (const [html, id, name] of [[bank, "item-delete", "Bank Delete"], [estate, "home-delete", "42 Main Street"]]) {
    assert.match(html, /class="connection-actions-menu"/);
    assert.match(html, /class="connection-menu-trigger"[^>]*>[\s\S]*⋯<\/span>[\s\S]*<\/summary>/);
    assert.match(html, /class="connection-menu-popup"[^>]*>[\s\S]*class="delete-connection-button"[^>]*>Delete<\/button>/);
    assert.doesNotMatch(html, /connection-chevron/);
    assert.match(html, new RegExp(`data-connection-id="${id}"`));
    assert.match(html, new RegExp(`data-connection-name="${name}"`));
  }
  const page = renderConnectionsPage({ displayName: "Test", username: "test" });
  assert.doesNotMatch(page, /id="delete-connection-dialog"|id="connection-dialog"/);
});

test("real-estate cards render separate provider estimates, manual add, and estimate history chart", async () => {
  const html = renderRealEstateCards([{ id: "home-1", address: "<script>alert(1)</script>", latitude: 47.6, longitude: -122.3, estimates: [{ amount: 750000, createdAt: 1790900000000 }, { amount: 700000, createdAt: 1788000000000 }] }]);
  assert.match(html, />Estimate:<\/strong>/);
  assert.doesNotMatch(html, /Current estimate/);
  assert.match(html, /\$750,000/);
  assert.doesNotMatch(html, /\$700,000/);
  assert.doesNotMatch(html, /Manual estimate history/);
  assert.doesNotMatch(html, /class="estimate-edit-button"/);
  assert.doesNotMatch(html, /class="zillow-refresh-button"/);
  assert.match(html, /class="manual-estimate-add"/);
  assert.match(html, /class="estimate-history-chart"/);
  const allProvidersHtml = renderRealEstateCards([{ id: "home-all", address: "123 Main St", latitude: 47.6, longitude: -122.3, estimates: [{ amount: 795900, createdAt: 1791000000000, provider: "zillow" }, { amount: 780000, createdAt: 1790900000000, provider: "redfin" }, { amount: 750000, createdAt: 1790800000000, provider: "manual" }] }]);
  assert.match(allProvidersHtml, /class="estimate-source-link"[^>]*href="https:\/\/www\.zillow\.com/);
  assert.match(allProvidersHtml, /class="estimate-source-link"[^>]*href="https:\/\/www\.redfin\.com/);
  const scaledChart = renderRealEstateCards([{ id: "home-scale", address: "Chart Home", latitude: 0, longitude: 0, estimates: [{ amount: 100, createdAt: Date.UTC(2025, 0, 1), provider: "zillow" }, { amount: 200, createdAt: Date.UTC(2025, 0, 3), provider: "zillow" }] }]);
  assert.match(scaledChart, /data-y-min="0"/);
  assert.match(scaledChart, /data-y-max="220"/);
  assert.match(scaledChart, /2025-01-01/);
  assert.match(scaledChart, /class="estimate-series-zillow"/);
  assert.equal((scaledChart.match(/class="estimate-point-zillow"/g) ?? []).length, 2);
  assert.match(scaledChart, /data-tooltip-delay="300"/);
  assert.match(scaledChart, /class="estimate-chart-tooltip"[^>]*hidden/);
  assert.match(scaledChart, /class="estimate-chart-tooltip-date"/);
  assert.match(scaledChart, /class="estimate-chart-tooltip-value"/);
  assert.match(scaledChart, /data-estimate-date="2025-01-01" data-estimate-value="\$100"/);
  assert.doesNotMatch(scaledChart, /<title>2025-01-01/);
  assert.match(allProvidersHtml, /class="estimate-series-zillow"/);
  assert.match(allProvidersHtml, /class="estimate-series-redfin"/);
  assert.match(allProvidersHtml, /class="estimate-series-manual"/);
  const zillowHtml = renderRealEstateCards([{ id: "home-zillow", address: "123 Main St", latitude: 47.6, longitude: -122.3, estimates: [{ amount: 795900, createdAt: 1791000000000, provider: "zillow" }] }]);
  assert.match(zillowHtml, /\$795,900/);
  assert.match(zillowHtml, /class="estimate-source">Zillow Zestimate<\/span>/);
  assert.match(html, /class="manual-estimate-add"/);
  assert.match(html, /class="manual-estimate-form"[^>]*hidden/);
  assert.match(html, /name="amount"/);
  assert.match(html, /name="sourceNotes"/);
  assert.match(html, /class="manual-estimate-cancel"/);
  assert.match(html, /<svg[^>]*class="estimate-history-chart"/);
  assert.match(html, /class="property-map-frame"/);
  assert.match(html, /maps\.google\.com/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>alert/);
  const css = await readFile(new URL("../src/style.css", import.meta.url), "utf8");
  assert.match(css, /\.estimate-chart-tooltip-date[^}]*font-weight:\s*700/);
  assert.match(css, /\.estimate-point-zillow:focus[^}]*stroke:\s*#153e9c/);
  const client = await readFile(new URL("../src/real-estate.ts", import.meta.url), "utf8");
  assert.match(client, /showChartTooltip\(marker,\s*0\)/);
  assert.match(client, /chartPoint\.focus\(/);
  assert.match(css, /\.estimate-edit-button\[hidden\]\s*\{\s*display:\s*none/);
  assert.match(css, /\.real-estate-details[^}]*grid-template-columns: minmax\(0, 1fr\) minmax\(180px, 42%\)/);
  assert.match(css, /@media \(max-width: 620px\)[\s\S]*\.real-estate-details[^}]*grid-template-columns: 1fr/);
});

test("real-estate page uses an inline address autocomplete and Zillow form", async () => {
  const html = renderConnectionsPage({ displayName: "Test", username: "test" });
  const css = await readFile(new URL("../src/style.css", import.meta.url), "utf8");
  const deleteDialogRule = css.match(/\.delete-connection-dialog\s*\{([^}]*)\}/)?.[1] ?? "";
  assert.match(deleteDialogRule, /width:\s*min\(400px,/);
  assert.match(css, /\.delete-connection-dialog\s*>\s*\.panel\s*\{[^}]*height:\s*auto[^}]*padding:\s*22px/);
  const panelRule = css.match(/\.connection-dialog\s*>\s*\.panel\s*\{([^}]*)\}/)?.[1] ?? "";
  assert.match(panelRule, /height:\s*var\(--connection-dialog-height,/);
  assert.match(css, /#connection-dialog\[data-step="choices"\]\s*>\s*\.panel\s*\{[^}]*--connection-dialog-height:\s*min\(46vh,\s*360px\)/);
  assert.match(css, /#connection-dialog\[data-step="address"\]\s*>\s*\.panel\s*\{[^}]*--connection-dialog-height:\s*min\(72vh,\s*540px\)/);
  assert.match(css, /#connection-dialog\[data-step="provider"\]\s*>\s*\.panel\s*\{[^}]*--connection-dialog-height:\s*min\(72vh,\s*540px\)/);
  assert.match(panelRule, /display:\s*flex/);
  assert.match(panelRule, /flex-direction:\s*column/);
  assert.match(css, /#connection-choices\s*\{[^}]*flex:\s*1[^}]*align-content:\s*center/s);
  const wizardRule = css.match(/#real-estate-wizard\s*\{([^}]*)\}/)?.[1] ?? "";
  assert.match(wizardRule, /flex:\s*1/);
  assert.match(wizardRule, /display:\s*flex/);
  assert.match(wizardRule, /flex-direction:\s*column/);
  assert.match(css, /#real-estate-step-provider\s*\{[^}]*flex:\s*1[^}]*align-content:\s*center/s);
  assert.match(css, /#zillow-estimate-step\[hidden\]/);
  assert.match(css, /\.real-estate-wizard-actions\s*\{[^}]*margin-top:\s*auto/s);
  assert.match(css, /#property-map-preview\s*\{[^}]*height:\s*240px/s);
  assert.match(html, /id="add-property"/);
  assert.doesNotMatch(html, /<h3>Choose property<\/h3>/);
  assert.match(css, /#real-estate-step-address\s*\{[^}]*overflow:\s*hidden/);
  assert.match(css, /@media \(max-height:\s*700px\)[\s\S]*#property-map-preview\s*\{[^}]*height:\s*180px/);
  assert.match(css, /#property-map-preview iframe\s*\{[^}]*height:\s*100%/s);
});

test("real-estate page offers an address form and optional Zillow source", () => {
  const html = renderConnectionsPage({ displayName: "Test", username: "test" });
  assert.match(html, /id="add-property"/);
  assert.match(html, /id="new-property-panel" hidden/);
  assert.match(html, /id="property-address"[^>]*autocomplete="off"/);
  assert.match(html, /id="zillow-property-url" name="zillowUrl" type="url"/);
  assert.match(html, /id="done-property"[^>]*>Done/);
});

test("real-estate property creation uses selected address and Zillow URL", async () => {
  const html = renderConnectionsPage({ displayName: "Test", username: "test" });
  const client = await readFile(new URL("../src/bank_accounts.ts", import.meta.url), "utf8");
  assert.match(html, /id="add-property"/);
  assert.match(html, /id="address-suggestions" role="listbox"/);
  assert.match(html, /id="zillow-url-field" hidden/);
  assert.match(client, /nominatim\.openstreetmap\.org\/search/);
  assert.match(client, /zillowUrl:String\(data\.get\("zillowUrl"\)\?\?""\)/);
  assert.match(client, /id="done-property"/);
});


test("real-estate source migration adds Redfin URL to databases already on migration 0007", async () => {
  const database = new Database(":memory:");
  database.exec("CREATE TABLE real_estate_connection (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, address TEXT NOT NULL, latitude REAL NOT NULL, longitude REAL NOT NULL, zillow_url TEXT)");
  const migration = await readFile(new URL("../server/migrations/0008_redfin_url.sql", import.meta.url), "utf8");
  applySqlMigration(database, migration);
  const columns = database.prepare("PRAGMA table_info(real_estate_connection)").all().map((column) => column.name);
  assert.ok(columns.includes("redfin_url"));
  database.close();
});

test("real-estate migration persists owned connections and timestamped estimate history", async () => {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  for (const migrationName of (await readdir(migrationsDirectory)).filter((name) => name.endsWith(".sql")).sort()) {
    applySqlMigration(database, await readFile(new URL(migrationName, migrationsDirectory), "utf8"));
  }
  const tables = database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name);
  assert.ok(tables.includes("real_estate_connection"));
  assert.ok(tables.includes("real_estate_estimate"));
  const connectionColumns = database.prepare("PRAGMA table_info(real_estate_connection)").all().map((column) => column.name);
  assert.ok(connectionColumns.includes("user_id"));
  assert.ok(connectionColumns.includes("latitude"));
  assert.ok(connectionColumns.includes("longitude"));
  database.prepare("INSERT INTO user(id,name,email) VALUES('owner-a','Owner A','a@example.test'),('owner-b','Owner B','b@example.test')").run();
  database.prepare("INSERT INTO real_estate_connection(id,user_id,address,latitude,longitude) VALUES('property-a','owner-a','123 Main St',47.6,-122.3)").run();
  database.prepare("INSERT INTO real_estate_estimate(id,connection_id,user_id,provider,amount,created_at) VALUES('estimate-old','property-a','owner-a','manual',700000,1788000000000),('estimate-new','property-a','owner-a','manual',750000,1790900000000)").run();
  database.prepare("INSERT INTO real_estate_estimate(id,connection_id,user_id,provider,amount,created_at) VALUES('estimate-zillow','property-a','owner-a','zillow',795900,1791000000000)").run();
  const estimates = database.prepare("SELECT amount,provider,created_at AS createdAt FROM real_estate_estimate WHERE user_id=? AND connection_id=? ORDER BY created_at DESC").all("owner-a","property-a");
  assert.deepEqual(estimates.map((estimate) => [estimate.amount, estimate.provider]), [[795900,"zillow"],[750000,"manual"],[700000,"manual"]]);
  assert.throws(() => database.prepare("INSERT INTO real_estate_estimate(id,connection_id,user_id,provider,amount) VALUES('foreign-estimate','property-a','owner-b','manual',1)").run(), /FOREIGN KEY/);
  database.close();
});


test("logout action is placed in a Settings section after Change password", async () => {
  const settingsSource = await readFile(new URL("../src/main.ts", import.meta.url), "utf8");
  const passwordSection = settingsSource.indexOf("<h2>Change password</h2>");
  const logoutSection = settingsSource.indexOf('class="settings-card settings-logout-section"');
  assert.ok(passwordSection >= 0);
  assert.ok(logoutSection > passwordSection);
  assert.match(settingsSource.slice(logoutSection), /class="primary-button logout-button"/);
  assert.doesNotMatch(settingsSource.slice(0, logoutSection), /logout-button/);
});

test("bank connection client requests owned Connect configuration and saves the enrollment", async () => {
  const client = await readFile(new URL("../src/bank_accounts.ts", import.meta.url), "utf8");
  assert.match(client, /\/api\/accounts\/connect-config/);
  assert.match(client, /\/api\/accounts\/enroll/);
  assert.match(client, /TellerConnect\.setup\(/);
  assert.match(client, /applicationId/);
  assert.match(client, /environment/);
  assert.match(client, /JSON\.stringify\(\{\s*\.\.\.enrollment,\s*nonce\s*\}\)/);
  assert.match(client, /completeTellerConnection\(enrollment,\s*nonce\)/);
});

test("accounts page places sync-all before Connect a bank", () => {
  const html = renderBankAccountsPage({ displayName: "Test User", username: "test-user" });
  assert.ok(html.indexOf('id="sync-all-institutions"') >= 0);
  assert.ok(html.indexOf('id="sync-all-institutions"') < html.indexOf('id="connect-bank"'));
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
    { name: "Merchant <unsafe>", date: "2026-10-27", amount: Number.NaN, iso_currency_code: "USD", pending: true },
    { name: "International purchase", date: "2026-10-26", amount: -2.34, unofficial_currency_code: "EUR" },
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
  assert.match(html, /<span>2026-10-27 · Pending<\/span>/);
  assert.match(html, /<b>—<\/b>/);
  assert.match(html, /<b>€2\.34<\/b>/);
  assert.doesNotMatch(html, /<unsafe>/);
  const differentlyNamedSavings = { ...matchingSavings, name: "Everyday Savings", subtype: "savings" };
  const reverseTransfer = renderAccountDetail(account, [
    { name: "Internet transfer from Savings account XXXXXX4753", date: "2026-10-26", amount: 7, iso_currency_code: "USD" },
  ], [account, differentlyNamedSavings]);
  assert.match(reverseTransfer, /Internet transfer from <a class="transaction-account-link" href="\/accounts\/savings-id">Savings account XXXXXX4753<\/a>/);
  assert.ok(html.indexOf("account-detail-snapshot") < html.indexOf("account-detail-transactions"));
});

test("account details render a matching Fidelity ACH deposit as a collapsed transfer", () => {
  const allyAccount = {
    id: "ally-checking",
    itemId: "ally-item",
    providerAccountId: "provider-ally-checking",
    institutionName: "Ally Bank",
    name: "Checking",
    officialName: null,
    type: "depository",
    subtype: "checking",
    mask: "5566",
    currentBalance: 1000,
    availableBalance: 900,
    currencyCode: "USD",
    updatedAt: "2026-10-31T12:00:00.000Z",
  };
  const fidelityAccount = {
    id: "fidelity-tod",
    itemId: "fidelity-item",
    providerAccountId: "provider-fidelity-tod",
    institutionName: "Fidelity",
    name: "Individual - TOD",
    officialName: null,
    type: "investment",
    subtype: "brokerage",
    mask: "1283",
    currentBalance: 25000,
    availableBalance: null,
    currencyCode: "USD",
    updatedAt: "2026-10-31T12:00:00.000Z",
  };
  const transaction = {
    transaction_id: "fidelity-ach-to-ally",
    account_id: "provider-ally-checking",
    name: "X77621283 708XN FID BKG SVC LLC ACH",
    date: "2026-10-27",
    amount: -25004.82,
    iso_currency_code: "USD",
  };

  const html = renderAccountDetail(allyAccount, [transaction], [allyAccount, fidelityAccount]);
  assert.match(html, /<details class="transaction-transfer-pair">/);
  assert.match(html, /Transfer: Individual - TOD → Checking/);
  assert.match(html, /class="transfer-pair-amount">\$25,004\.82/);
  assert.match(html, /class="transfer-pair-rows">[\s\S]*?<a class="transaction-account-link" href="\/accounts\/fidelity-tod">X77621283<\/a> 708XN FID BKG SVC LLC ACH/);
  assert.doesNotMatch(html, /class="account-transaction-row"/);

  const duplicateFidelityAccount = { ...fidelityAccount, id: "fidelity-duplicate", mask: "51283" };
  const ambiguousHtml = renderAccountDetail(allyAccount, [transaction], [allyAccount, fidelityAccount, duplicateFidelityAccount]);
  assert.doesNotMatch(ambiguousHtml, /<a class="transaction-account-link" href="\/accounts\/fidelity-tod">X77621283<\/a>/);

  const unrelatedTransaction = { ...transaction, name: "X77621283 OTHER MERCHANT ACH" };
  const unrelatedHtml = renderAccountDetail(allyAccount, [unrelatedTransaction], [allyAccount, fidelityAccount]);
  assert.doesNotMatch(unrelatedHtml, /<a class="transaction-account-link"[^>]*>X77621283<\/a>/);

  const otherFidelityAccount = { ...fidelityAccount, id: "fidelity-2345", mask: "2345" };
  const misleadingTransaction = {
    ...transaction,
    name: "X88882345 unrelated X77621283 708XN FID BKG SVC LLC ACH",
  };
  const misleadingHtml = renderAccountDetail(allyAccount, [misleadingTransaction], [
    allyAccount,
    fidelityAccount,
    otherFidelityAccount,
  ]);
  assert.doesNotMatch(misleadingHtml, /<a class="transaction-account-link" href="\/accounts\/fidelity-2345">X88882345<\/a>/);
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
      "INSERT INTO bank_item (item_id, user_id, encrypted_institution_name, encrypted_access_token, provider) VALUES (?, ?, ?, ?, 'teller')",
    )
    .run("item-one", "user-one", "encrypted-name", "encrypted-token");
  database
    .prepare(
      "INSERT INTO bank_account (id, provider_account_id, item_id, user_id, encrypted_data) VALUES (?, ?, ?, ?, ?)",
    )
    .run("account-one", "provider-account-one", "item-one", "user-one", "encrypted-data");

  assert.throws(
    () =>
      database
        .prepare(
          "INSERT INTO bank_account (id, provider_account_id, item_id, user_id, encrypted_data) VALUES (?, ?, ?, ?, ?)",
        )
        .run("account-two", "provider-account-two", "item-one", "user-two", "encrypted-data"),
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
  const { refreshBankAccountSnapshots } = await import("../server-dist/account-storage.js");
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
  database.prepare("INSERT INTO bank_item (item_id, user_id, encrypted_institution_name, encrypted_access_token, provider) VALUES (?, ?, ?, ?, 'teller')")
    .run("item-one", "user-one", "encrypted-name", "encrypted-token");

  refreshBankAccountSnapshots(database, "item-one", "user-one", [
    { providerAccountId: "provider-account-one", encryptedData: "encrypted-v1" },
  ]);
  const original = database.prepare("SELECT id FROM bank_account WHERE item_id = ?")
    .get("item-one");
  refreshBankAccountSnapshots(database, "item-one", "user-one", []);
  const inactive = database.prepare("SELECT id, is_active FROM bank_account WHERE item_id = ?")
    .get("item-one");
  assert.equal(inactive.id, original.id);
  assert.equal(inactive.is_active, 0);

  refreshBankAccountSnapshots(database, "item-one", "user-one", [
    { providerAccountId: "provider-account-one", encryptedData: "encrypted-v2" },
  ]);
  const reactivated = database.prepare("SELECT id, is_active, encrypted_data FROM bank_account WHERE item_id = ?")
    .get("item-one");
  assert.equal(reactivated.id, original.id);
  assert.equal(reactivated.is_active, 1);
  assert.equal(reactivated.encrypted_data, "encrypted-v2");
  database.close();
});

test("account transaction queries are scoped to the owning user, item, and account", async () => {
  const { listAccountTransactions } = await import("../server-dist/account-storage.js");
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
  const insertItem = database.prepare("INSERT INTO bank_item (item_id, user_id, encrypted_institution_name, encrypted_access_token, provider) VALUES (?, ?, ?, ?, 'teller')");
  insertItem.run("item-one", "user-one", "encrypted-name", "encrypted-token");
  insertItem.run("item-two", "user-two", "encrypted-name", "encrypted-token");
  insertItem.run("item-three", "user-one", "encrypted-name", "encrypted-token");
  const key = Buffer.alloc(32, 23);
  const insertTransaction = database.prepare("INSERT INTO bank_transaction (transaction_id, item_id, user_id, account_id, encrypted_data) VALUES (?, ?, ?, ?, ?)");
  const encode = (name, date) => encryptBankValue(JSON.stringify({ name, date }), key);
  insertTransaction.run("tx-one", "item-one", "user-one", "account-one", encode("Target account transaction", "2026-10-29"));
  insertTransaction.run("tx-two", "item-one", "user-one", "account-two", encode("Another account transaction", "2026-10-30"));
  insertTransaction.run("tx-three", "item-two", "user-two", "account-one", encode("Another user transaction", "2026-10-30"));
  insertTransaction.run("tx-four", "item-three", "user-one", "account-one", encode("Another institution transaction", "2026-10-30"));

  const transactions = listAccountTransactions(database, "user-one", "item-one", "account-one", key);
  assert.deepEqual(transactions.map((transaction) => transaction.name), ["Target account transaction"]);
  assert.deepEqual(listAccountTransactions(database, "user-two", "item-one", "account-one", key), []);
  assert.deepEqual(listAccountTransactions(database, "user-one", "item-two", "account-one", key), []);
  assert.deepEqual(listAccountTransactions(database, "user-one", "item-one", "missing-account", key), []);
  database.close();
});

test("all transaction queries return every account for one user without the dashboard limit", async () => {
  const { listAllUserTransactions } = await import("../server-dist/account-storage.js");
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
  const insertItem = database.prepare("INSERT INTO bank_item (item_id, user_id, encrypted_institution_name, encrypted_access_token, provider) VALUES (?, ?, ?, ?, 'teller')");
  insertItem.run("item-one", "user-one", "encrypted-name", "encrypted-token");
  insertItem.run("item-two", "user-two", "encrypted-name", "encrypted-token");
  const key = Buffer.alloc(32, 23);
  const insertTransaction = database.prepare("INSERT INTO bank_transaction (transaction_id, item_id, user_id, account_id, encrypted_data) VALUES (?, ?, ?, ?, ?)");
  for (let index = 0; index < 55; index += 1) {
    insertTransaction.run(
      `tx-${index}`,
      "item-one",
      "user-one",
      index % 2 === 0 ? "account-one" : "account-two",
      encryptBankValue(JSON.stringify({ transaction_id: `tx-${index}`, account_id: index % 2 === 0 ? "account-one" : "account-two", name: `Transaction ${index}`, date: "2026-10-30", amount: index }), key),
    );
  }
  insertTransaction.run(
    "tx-other-user",
    "item-two",
    "user-two",
    "account-one",
    encryptBankValue(JSON.stringify({ transaction_id: "tx-other-user", name: "Other user's transaction", date: "2026-10-30", amount: 1 }), key),
  );

  const transactions = listAllUserTransactions(database, "user-one", key);
  assert.equal(transactions.length, 55);
  assert.equal(new Set(transactions.map((transaction) => transaction.account_id)).size, 2);
  assert.equal(transactions.some((transaction) => transaction.transaction_id === "tx-other-user"), false);
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
  database.prepare("INSERT INTO bank_item (item_id, user_id, encrypted_institution_name, encrypted_access_token, provider) VALUES (?, ?, ?, ?, 'teller')")
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

test("account sync and disconnect enforce owner scope and preserve data on remote failure", async () => {
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", `
    import assert from "node:assert/strict";
    import { mkdtemp, rm } from "node:fs/promises";
    import { join } from "node:path";
    import { encryptBankValue, getBankEncryptionKey } from "./server-dist/bank-crypto.js";
    await (${runBankAndPropertyLifecycle.toString()})();
  `], { cwd: new URL("../", import.meta.url), encoding: "utf8", timeout: 60_000 });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

async function runBankAndPropertyLifecycle() {
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
    const databaseModule = await import("./server-dist/database.js");
    const { createBankAccountsRouter } = await import("./server-dist/bank_accounts.js");
    const { realEstateRouter } = await import("./server-dist/real_estate.js");
    const { auth } = await import("./server-dist/auth.js");
    closeDatabase = databaseModule.closeDatabase;
    await databaseModule.runMigrations();
    const db = databaseModule.sqliteClient;
    const key = getBankEncryptionKey();
    const settings = { applicationId: "app_test", environment: "sandbox", certificate: null, privateKey: null, signingKey: null };
    let sessionUserId = null;
    let failRemoval = false;
    const calls = [];
    const transport = async (configuration, token, method, path) => {
      assert.equal(configuration.applicationId, "app_test");
      assert.equal(configuration.environment, "sandbox");
      calls.push({ token, method, path });
      if (method === "DELETE") {
        if (failRemoval) throw new Error("sensitive remote failure");
        return null;
      }
      assert.equal(token, "mock-access-token", "only the selected institution's token reaches Teller");
      if (path === "/accounts") return [{ id: "provider-account-one", enrollment_id: "item-one", name: "Checking", type: "depository", subtype: "checking", currency: "USD", last_four: "1234", status: "open", institution: { id: "bank-one", name: "Bank One" } }];
      if (path === "/accounts/provider-account-one/balances") return { account_id: "provider-account-one", ledger: "125.00", available: "100.00" };
      if (path === "/accounts/provider-account-one/transactions?count=500") return [];
      assert.fail(`Unexpected Teller request: ${method} ${path}`);
    };
    const bankAccountsRouter = createBankAccountsRouter({ database: db, getUserId: async () => sessionUserId, getSettings: () => settings, getEncryptionKey: () => key, transport });
    const request = (path, method = "GET", body) => bankAccountsRouter.request(path, {
      method, headers: { Origin: "http://localhost:5173", "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    for (const [path, method] of [["/", "GET"], ["/items", "GET"], ["/transactions", "GET"], ["/transactions/all", "GET"], ["/account-one/transactions", "GET"], ["/transactions/sync", "POST"], ["/items/item-one/transactions/sync", "POST"], ["/items/item-one", "DELETE"], ["/connect-config", "POST"], ["/enroll", "POST"]]) {
      const response = await request(path, method);
      assert.equal(response.status, 401, `${method} ${path} requires authentication`);
      assert.equal(response.headers.get("Cache-Control"), "no-store");
    }
    assert.deepEqual(calls, []);
    for (const userId of ["user-one", "user-two"]) db.prepare("INSERT INTO user(id,name,email) VALUES(?,?,?)").run(userId, userId, `${userId}@example.test`);
    const insertItem = db.prepare("INSERT INTO bank_item(item_id,user_id,encrypted_institution_name,encrypted_access_token,provider,provider_application_id,provider_environment,updated_at) VALUES(?,?,?,?, 'teller','app_test','sandbox',?)");
    insertItem.run("item-one", "user-one", encryptBankValue("Bank One", key), encryptBankValue("mock-access-token", key), 1000);
    insertItem.run("item-two", "user-one", encryptBankValue("Bank Two", key), encryptBankValue("other-mock-access-token", key), 2000);
    insertItem.run("item-other-user", "user-two", encryptBankValue("Private Bank", key), encryptBankValue("private-access-token", key), 3000);
    const originalGetSession = auth.api.getSession;
    auth.api.getSession = async () => sessionUserId ? { user: { id: sessionUserId } } : null;
    try {
      sessionUserId = "user-two";
      assert.equal((await request("/items/item-one/transactions/sync", "POST")).status, 404);
      assert.equal((await request("/items/item-one", "DELETE")).status, 404);
      assert.equal((await request("/account-one/transactions")).status, 404);
      assert.deepEqual(calls, []);
      sessionUserId = "user-one";
      const insertTransaction = db.prepare("INSERT INTO bank_transaction(transaction_id,item_id,user_id,account_id,encrypted_data) VALUES(?,?,?,?,?)");
      const saveTransaction = (id, item, owner, account, name) => insertTransaction.run(id, item, owner, account, encryptBankValue(JSON.stringify({ transaction_id: id, account_id: account, name, date: "2026-10-30", amount: 5 }), key));
      saveTransaction("first-item-transaction", "item-one", "user-one", "provider-account-one", "First bank");
      saveTransaction("second-item-transaction", "item-two", "user-one", "provider-account-two", "Second bank");
      saveTransaction("private-transaction", "item-other-user", "user-two", "provider-account-one", "Private transaction");
      const allAcrossItemsResponse = await request("/transactions/all");
      assert.equal(allAcrossItemsResponse.status, 200);
      assert.equal(allAcrossItemsResponse.headers.get("Cache-Control"), "no-store");
      assert.deepEqual((await allAcrossItemsResponse.json()).transactions.map(tx => tx.name).sort(), ["First bank", "Second bank"]);
      const siblingBefore = db.prepare("SELECT * FROM bank_item WHERE item_id='item-two'").get();
      const institutionSync = await request("/items/item-one/transactions/sync", "POST");
      assert.equal(institutionSync.status, 200);
      assert.deepEqual(await institutionSync.json(), { synced: true });
      assert.ok(calls.length > 0);
      assert.ok(calls.every(call => call.token === "mock-access-token"));
      assert.deepEqual(db.prepare("SELECT * FROM bank_item WHERE item_id='item-two'").get(), siblingBefore);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM bank_transaction WHERE item_id='item-two'").get().count, 1);
      const account = db.prepare("SELECT id FROM bank_account WHERE item_id='item-one'").get();
      assert.ok(account);
      db.prepare("UPDATE bank_account SET updated_at=? WHERE id=?").run(Date.parse("2025-01-05T12:00:00.000Z") / 1000, account.id);
      db.prepare("UPDATE bank_item SET updated_at=? WHERE item_id='item-one'").run(Date.parse("2026-10-31T12:00:00.000Z") / 1000);
      const accountsResponse = await request("/");
      assert.equal(accountsResponse.status, 200);
      const accountPayload = await accountsResponse.json();
      assert.equal(accountPayload.accounts.length, 1);
      assert.equal(accountPayload.accounts[0].providerAccountId, "provider-account-one");
      assert.equal(accountPayload.accounts[0].updatedAt, "2025-01-05T12:00:00.000Z");
      assert.equal(accountPayload.accounts[0].lastRetrievedAt, "2026-10-31T12:00:00.000Z");
      const itemsResponse = await request("/items");
      assert.equal(itemsResponse.status, 200);
      const connections = (await itemsResponse.json()).connections;
      assert.equal(connections.length, 2);
      const empty = connections.find(connection => connection.itemId === "item-two");
      assert.equal(empty.accountCount, 0);
      assert.deepEqual(empty.accounts, []);
      assert.deepEqual(connections.find(connection => connection.itemId === "item-one").accounts.map(child => child.id), [account.id]);
      saveTransaction("owned-detail", "item-one", "user-one", "provider-account-one", "Owned detail");
      saveTransaction("sibling-detail", "item-one", "user-one", "provider-sibling", "Sibling detail");
      const detail = await request(`/${account.id}/transactions`);
      assert.equal(detail.status, 200);
      assert.deepEqual((await detail.json()).transactions.map(tx => tx.name), ["Owned detail"]);
      const beforeWrongOwner = calls.length;
      sessionUserId = "user-two";
      assert.equal((await request(`/${account.id}/transactions`)).status, 404);
      assert.equal((await request("/items/item-one", "DELETE")).status, 404);
      assert.equal(calls.length, beforeWrongOwner);
      sessionUserId = "user-one";
      const state = () => ({ item: db.prepare("SELECT * FROM bank_item WHERE item_id='item-one'").get(), accounts: db.prepare("SELECT * FROM bank_account WHERE item_id='item-one'").all(), transactions: db.prepare("SELECT * FROM bank_transaction WHERE item_id='item-one' ORDER BY transaction_id").all() });
      const beforeFailure = state();
      failRemoval = true;
      const failedDisconnect = await request("/items/item-one", "DELETE");
      assert.equal(failedDisconnect.status, 502);
      assert.doesNotMatch(await failedDisconnect.text(), /sensitive remote failure|mock-access-token/);
      assert.deepEqual(state(), beforeFailure);
      failRemoval = false;
      const successfulDisconnect = await request("/items/item-one", "DELETE");
      assert.equal(successfulDisconnect.status, 204);
      assert.equal(calls.filter(call => call.method === "DELETE").length, 2);
      assert.equal(db.prepare("SELECT item_id FROM bank_item WHERE item_id='item-one'").get(), undefined);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM bank_account WHERE item_id='item-one'").get().count, 0);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM bank_transaction WHERE item_id='item-one'").get().count, 0);
      assert.deepEqual(db.prepare("SELECT * FROM bank_item WHERE item_id='item-two'").get(), siblingBefore);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM bank_transaction WHERE user_id='user-two'").get().count, 1);

      const originalFetch = globalThis.fetch;
      let zillowFetchCount = 0;
      globalThis.fetch = async () => {
        zillowFetchCount++;
        return new Response(`<meta property="og:description" content="The Zestimate for this home is $795,900. The Rent Zestimate is $3,757/mo.">`, { status: 200, headers: { "content-type": "text/html" } });
      };
      try {
        const zillowResponse = await realEstateRouter.request("/", {
          method: "POST",
          headers: { "Content-Type": "application/json", Origin: "http://localhost:5173" },
          body: JSON.stringify({ address: "15209 78th Ave NE, Kenmore, WA 98028", latitude: 47.73, longitude: -122.24, zillowUrl: "https://www.zillow.com/homedetails/example/48971089_zpid/" }),
        });
        assert.equal(zillowResponse.status, 201);
        assert.deepEqual(await zillowResponse.json().then(({provider,amount}) => ({provider,amount})), { provider: "zillow", amount: 795900 });
        assert.deepEqual(databaseModule.sqliteClient.prepare("SELECT provider,amount FROM real_estate_estimate WHERE user_id=?").get("user-one"), { provider: "zillow", amount: 795900 });
        const propertyList = await realEstateRouter.request("/");
        const propertyPayload = await propertyList.json();
        assert.equal(propertyPayload.properties[0].estimates[0].provider, "zillow");
        assert.equal(propertyPayload.properties[0].estimates[0].amount, 795900);
        const limitedZillowResponse = await realEstateRouter.request("/", {
          method: "POST",
          headers: { "Content-Type": "application/json", Origin: "http://localhost:5173" },
          body: JSON.stringify({ address: "Another home", latitude: 47.73, longitude: -122.24, zillowUrl: "https://www.zillow.com/homedetails/example/123_zpid/" }),
        });
        assert.equal(limitedZillowResponse.status, 201);
        assert.equal(zillowFetchCount, 2);

        sessionUserId = "user-two";
        const manualPropertyResponse = await realEstateRouter.request("/", {
          method: "POST",
          headers: { "Content-Type": "application/json", Origin: "http://localhost:5173" },
          body: JSON.stringify({ address: "123 Main St", latitude: 47.6, longitude: -122.3, amount: 700000 }),
        });
        assert.equal(manualPropertyResponse.status, 201);
        const manualProperty = await manualPropertyResponse.json();
        const updatedEstimateResponse = await realEstateRouter.request(`/${manualProperty.id}/zillow`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Origin: "http://localhost:5173" },
          body: JSON.stringify({ zillowUrl: "https://www.zillow.com/homedetails/example/48971089_zpid/" }),
        });
        assert.equal(updatedEstimateResponse.status, 201);
        assert.deepEqual(await updatedEstimateResponse.json().then(({provider,amount}) => ({provider,amount})), { provider: "zillow", amount: 795900 });
        assert.equal(zillowFetchCount, 3);
        sessionUserId = "user-one";
        const wrongOwnerEstimate = await realEstateRouter.request(`/${manualProperty.id}/zillow`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Origin: "http://localhost:5173" },
          body: JSON.stringify({ zillowUrl: "https://www.zillow.com/homedetails/example/48971089_zpid/" }),
        });
        assert.equal(wrongOwnerEstimate.status, 404);
        assert.equal(zillowFetchCount, 3);
      } finally {
        globalThis.fetch = originalFetch;
      }
    } finally {
      auth.api.getSession = originalGetSession;

    }
  } finally {
    await closeDatabase?.();
    for (const [name, value] of Object.entries(originalEnvironment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}
