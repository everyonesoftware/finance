import test from "node:test";
import assert from "node:assert/strict";
import { filterAndSortTransactionGroups } from "../src/transaction-filters.ts";

function account(id, overrides = {}) {
  return {
    id, itemId: `item-${id}`, providerAccountId: `provider-${id}`,
    institutionName: "Test Bank", name: id, officialName: null,
    type: "depository", subtype: "checking", mask: null,
    currentBalance: null, availableBalance: null, currencyCode: "USD",
    updatedAt: "2026-11-01", ...overrides,
  };
}
const checking = account("checking", { name: "Everyday Checking", institutionName: "North Bank", mask: "1234", officialName: "Premier Account" });
const savings = account("savings", { name: "Rainy Day Savings", institutionName: "South Bank", mask: "5678" });
const accounts = [checking, savings];
function single(name, overrides = {}) {
  return { type: "single", transactions: [{ name, account_id: checking.providerAccountId, date: "2026-11-01", amount: 10, iso_currency_code: "USD", ...overrides }] };
}
function search(groups, searchQuery, overrides = {}, availableAccounts = accounts) {
  return filterAndSortTransactionGroups(groups, availableAccounts, {
    includeAccountIds: accounts.map(({ id }) => id), excludeAccountIds: [],
    minimumAmount: -Infinity, maximumAmount: Infinity, sort: "date-desc",
    searchQuery, ...overrides,
  });
}

test("transaction metadata search includes merchant, dates, formatted amounts and only its matched account", () => {
  const purchase = single("Warehouse purchase", { merchant_name: "Costco", date: "2026-10-23", amount: 77.18 });
  const rounded = single("Rounded charge", { amount: 1234.5, date: "2026-10-22" });
  const otherAccount = single("Unrelated", { account_id: savings.providerAccountId, date: "2025-01-01", amount: 2 });
  const groups = [purchase, rounded, otherAccount];
  for (const query of ["costco", "2026-10-23", "77.18", "-$77.18"]) {
    assert.deepEqual(search(groups, query), [purchase], query);
  }
  for (const query of ["1,234.50", "234.50", "everyday checking", "north bank", "1234", "premier account"]) {
    assert.deepEqual(search(groups, query), query.includes("234.50") ? [rounded] : [purchase, rounded], query);
  }
  assert.deepEqual(search(groups, "rainy day"), [otherAccount]);
  assert.deepEqual(search(groups, "south bank"), [otherAccount]);
  assert.deepEqual(search(groups, "5678"), [otherAccount]);
  assert.deepEqual(search(groups, "77x18"), []);
  const sparse = single(undefined, { merchant_name: 42, date: null, iso_currency_code: null });
  assert.deepEqual(search([sparse], "not found"), []);
});

for (const type of ["transfer", "credit-card-payment"]) {
  test(`${type} search preserves every child and matches summary accounts and group label`, () => {
    const group = {
      type, fromAccount: checking, toAccount: savings,
      transactions: [
        { name: "Original withdrawal", account_id: checking.providerAccountId, amount: 77.18, date: "2026-10-20", iso_currency_code: "USD" },
        { name: "Child-only coffee detail", merchant_name: "Unique merchant", account_id: savings.providerAccountId, amount: -77.18, date: "2026-10-21", iso_currency_code: "USD" },
      ],
    };
    const groups = [single("Unrelated", { account_id: savings.providerAccountId }), group];
    for (const query of [type === "transfer" ? "TRANSFER" : "Credit Card Payment", "rainy day", "south bank", "5678", "everyday", "coffee", "unique merchant", "2026-10-21", "77.18", "$77.18"]) {
      const result = search(groups, query, {}, [checking]);
      assert.deepEqual(result, [group], query);
      assert.strictEqual(result[0], group);
      assert.strictEqual(result[0].transactions, group.transactions);
      assert.equal(result[0].transactions.length, 2);
    }
  });
}

test("search composes with account and amount filters without changing sorting or inputs", () => {
  const groups = [single("Coffee old", { amount: 5, date: "2026-10-01" }), single("Coffee new", { amount: 10 }), single("Other")];
  const snapshot = structuredClone({ groups, accounts });
  const expectedOrders = {
    "date-desc": [groups[1], groups[0]], "date-asc": [groups[0], groups[1]],
    "amount-desc": [groups[0], groups[1]], "amount-asc": [groups[1], groups[0]],
  };
  for (const [sort, expected] of Object.entries(expectedOrders)) {
    assert.deepEqual(search(groups, "coffee", { sort }), expected);
  }
  assert.deepEqual(search(groups, "coffee", { includeAccountIds: [] }), []);
  assert.deepEqual(search(groups, "coffee", { includeAccountIds: [savings.id] }), []);
  assert.deepEqual(search(groups, "coffee", { excludeAccountIds: [checking.id] }), []);
  assert.deepEqual(search(groups, "coffee", { minimumAmount: -6, maximumAmount: -4 }), [groups[0]]);
  for (const query of [undefined, "", "  \t\n"]) {
    assert.deepEqual(search(groups, query), search(groups, undefined));
  }
  const tie = single("Coffee tie");
  assert.deepEqual(search([groups[1], tie], "coffee"), [groups[1], tie]);
  assert.deepEqual({ groups, accounts }, snapshot);
});

test("transaction name search is a trimmed case-insensitive literal substring", () => {
  const coffee = single("Morning COFFEE stop");
  const costco = single("Costco warehouse");
  const groups = [coffee, costco, single("Corner office"), single("Coffee-shop [A]")];
  assert.deepEqual(search(groups, "  cOfFeE  "), [coffee, groups[3]]);
  assert.deepEqual(search(groups, "Costco"), [costco]);
  assert.deepEqual(search(groups, "cfe"), []);
  assert.deepEqual(search(groups, "[a]"), [groups[3]]);
  assert.deepEqual(search(groups, "coffee shop"), []);
});
