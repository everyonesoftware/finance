import assert from "node:assert/strict";
import test from "node:test";
import { groupInternalTransfers, renderTransactionList, renderRecentTransactionList } from "../src/transaction-list.ts";
import { filterAndSortTransactionGroups, getTransactionGroupAmount } from "../src/transaction-filters.ts";
import { renderAccountDetail } from "../src/bank_accounts.ts";

const account = {
  id: "capital-one", providerAccountId: "capital-one-card", institutionName: "CapitalOne", name: "CapitalOne Card",
  type: "credit", subtype: "credit card", currencyCode: "USD",
};
const records = [6.13, 14.62].map((amount, index) => ({
  transaction_id: `reward-${index}`, account_id: account.providerAccountId,
  name: "CREDIT-TRAVEL REWARD CREDIT-TRAVEL REWARD", date: "2026-11-02",
  amount: -amount, iso_currency_code: "USD", pending: false,
}));

test("same-day Capital One travel rewards form an expandable total on every transaction surface", () => {
  const before = structuredClone(records);
  for (const originals of [records, [...records].reverse()]) {
    const groups = groupInternalTransfers(originals, [account]);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].type, "travel-reward");
    assert.equal(groups[0].receivingAccount.id, account.id);
    assert.deepEqual(groups[0].transactions, originals);
    assert.equal(getTransactionGroupAmount(groups[0]), 20.75);
    for (const html of [
      renderTransactionList(originals, [account], { showAccount: true }),
      renderRecentTransactionList(originals, [account]),
      renderAccountDetail(account, originals, [account]),
    ]) {
      assert.match(html, /<details class="transaction-transfer-pair">/);
      assert.match(html, /<strong>Travel rewards → CapitalOne Card<\/strong>/);
      assert.match(html, /Travel rewards · 2 transactions/);
      assert.match(html, /class="transfer-pair-amount">\$20\.75/);
      assert.match(html, /aria-label="Expand or collapse original travel reward credits"/);
      assert.match(html, /Original credits/);
      assert.equal((html.match(/class="account-row transaction-row"/g) ?? []).length, 2);
      assert.match(html, /\$6\.13/);
      assert.match(html, /\$14\.62/);
    }
  }
  assert.deepEqual(records, before);
});

test("travel reward search, amount filters and sorting use the full credit total", () => {
  const groups = groupInternalTransfers(records, [account]);
  const filters = { includeAccountIds: [account.id], excludeAccountIds: [], minimumAmount: 20, maximumAmount: 21, sort: "amount-desc" };
  for (const searchQuery of ["$20.75", " travel REWARDS ", "Original credits", "14.62", "CapitalOne"]) {
    assert.deepEqual(filterAndSortTransactionGroups(groups, [account], { ...filters, searchQuery }), groups);
  }
  for (const overrides of [{ includeAccountIds: [] }, { excludeAccountIds: [account.id] }, { maximumAmount: 20.74 }, { minimumAmount: 20.76 }, { searchQuery: "not found" }]) {
    assert.deepEqual(filterAndSortTransactionGroups(groups, [account], { ...filters, ...overrides }), []);
  }
  const purchase = { ...records[0], name: "Purchase", transaction_id: "purchase", amount: 30 };
  const mixed = groupInternalTransfers([purchase, ...records], [account]);
  assert.deepEqual(filterAndSortTransactionGroups(mixed, [account], { ...filters, minimumAmount: -100, maximumAmount: 100 }).map(getTransactionGroupAmount), [20.75, -30]);
});

test("reward batches stay scoped to card, date and currency, preserving repeated credits", () => {
  const other = { ...account, id: "other", providerAccountId: "other-card" };
  const batches = [records, records.map(r => ({ ...r, account_id: other.providerAccountId })), records.map(r => ({ ...r, date: "2026-11-03" })), records.map(r => ({ ...r, iso_currency_code: "EUR" }))];
  const input = [...batches.map(pair => pair[0]), ...batches.map(pair => pair[1])];
  const groups = groupInternalTransfers(input, [account, other]);
  assert.equal(groups.length, 4);
  assert.ok(groups.every(group => group.type === "travel-reward" && group.transactions.length === 2));
  assert.equal(groupInternalTransfers([records[0], { ...records[0], transaction_id: "repeat" }], [account])[0].transactions.length, 2);
});

test("only posted incoming credits with the observed descriptor on a Capital One credit card qualify", () => {
  for (const overrides of [
    { amount: 6.13 }, { amount: 0 }, { amount: NaN }, { amount: Infinity }, { amount: null },
    { pending: true }, { account_id: "unknown" }, { iso_currency_code: null },
    { date: "2026-02-30" }, { date: null }, { name: "TRAVEL REWARD" },
    { name: records[0].name + " unrelated" }, { name: "CREDIT-CASH REWARD" },
  ]) assert.ok(groupInternalTransfers(records.map(r => ({ ...r, ...overrides })), [account]).every(g => g.type === "single"), JSON.stringify(overrides));
  for (const overrides of [{ institutionName: "Citi" }, { type: "depository" }, { subtype: "loan" }]) {
    assert.ok(groupInternalTransfers(records, [{ ...account, ...overrides }]).every(g => g.type === "single"));
  }
  assert.equal(groupInternalTransfers([records[0]], [account])[0].type, "travel-reward");
  assert.equal(groupInternalTransfers(records.map(r => ({ ...r, name: "  credit-travel   reward credit-travel reward  ", iso_currency_code: null, unofficial_currency_code: "USD" })), [{ ...account, institutionName: "Capital One" }])[0].type, "travel-reward");
  assert.doesNotMatch(renderTransactionList(records, [{ ...account, name: '<img src=x onerror="alert(1)">' }]), /<img/);
});

test("a lone travel reward stays inside a collapsed group on every transaction surface", () => {
  const originals = [records[0]];
  const groups = groupInternalTransfers(originals, [account]);
  assert.equal(groups[0].type, "travel-reward");
  assert.deepEqual(groups[0].transactions, originals);
  assert.equal(getTransactionGroupAmount(groups[0]), 6.13);
  for (const html of [
    renderTransactionList(originals, [account]),
    renderRecentTransactionList(originals, [account]),
    renderAccountDetail(account, originals, [account]),
  ]) {
    assert.match(html, /<details class="transaction-transfer-pair">/);
    assert.doesNotMatch(html, /<details[^>]*\bopen\b/);
    assert.match(html, /Travel rewards · 1 transaction<\/span>/);
    assert.match(html, /class="transfer-pair-amount">\$6\.13/);
    assert.match(html, /Original credits/);
    assert.equal((html.match(/class="account-row transaction-row"/g) ?? []).length, 1);
  }
  const filters = { includeAccountIds: [account.id], excludeAccountIds: [], minimumAmount: 6.13, maximumAmount: 6.13, sort: "date-desc" };
  for (const searchQuery of ["Travel rewards", "Original credits", "$6.13"]) {
    assert.deepEqual(filterAndSortTransactionGroups(groups, [account], { ...filters, searchQuery }), groups);
  }
  const separateDates = records.map((record, index) => ({ ...record, date: `2026-11-0${index + 2}` }));
  assert.deepEqual(groupInternalTransfers(separateDates, [account]).map(group => group.type), ["travel-reward", "travel-reward"]);
});
