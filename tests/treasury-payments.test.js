import assert from "node:assert/strict";
import test from "node:test";
import { groupInternalTransfers, renderTransactionGroups, renderTransactionList } from "../src/transaction-list.ts";
import { filterAndSortTransactionGroups, getTransactionGroupAmount } from "../src/transaction-filters.ts";
import { renderAccountDetail } from "../src/bank_accounts.ts";
import * as transactionList from "../src/transaction-list.ts";

const account = {
  id: "bonds", providerAccountId: "ally-bonds", institutionName: "Ally", name: "Bonds",
  type: "depository", subtype: "savings", currencyCode: "USD",
};
const amounts = [45.38, 37.13, 41.25, 11.56, 11.56, 12.19, 12.19, 22.75, 22.75];
const records = amounts.map((amount, index) => ({
  transaction_id: `treasury-${index}`, account_id: account.providerAccountId,
  name: `APA TREAS 310 MISC PAY~ Future Amount: ${amount.toFixed(2)} ~ Tran: DDIR`,
  date: "2026-11-02", amount: -amount, iso_currency_code: "USD", pending: false,
}));

test("same-day TreasuryDirect credits render one batch with every original payment and the approved label", () => {
  const before = structuredClone(records);
  for (const originals of [records, [...records].reverse()]) {
    const groups = groupInternalTransfers(originals, [account]);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].type, "treasury-payment");
    assert.equal(groups[0].receivingAccount.id, account.id);
    assert.deepEqual(groups[0].transactions, originals);
    assert.equal(getTransactionGroupAmount(groups[0]), 216.76);
    for (const html of [
      renderTransactionList(originals, [account], { showAccount: true }),
      renderTransactionGroups(groups, [account]),
      renderAccountDetail(account, originals, [account]),
    ]) {
      assert.match(html, /<details class="transaction-transfer-pair">/);
      assert.match(html, /<strong>TreasuryDirect → Bonds<\/strong>/);
      assert.match(html, /<span>2026-11-02<\/span>/);
      assert.match(html, /<span class="transaction-group-type">Bond payments · 9 transactions<\/span>/);
      assert.match(html, /class="transfer-pair-amount">\$216\.76/);
      assert.match(html, /<div class="transfer-pair-details-label">Original payments<\/div>/);
      assert.doesNotMatch(html, /Original payments ·|Bond interest|Bond maturity/);
      assert.equal((html.match(/class="account-row transaction-row"/g) ?? []).length, 9);
      for (const original of originals) assert.ok(html.includes(original.name));
    }
  }
  assert.deepEqual(records, before);
});

test("TreasuryDirect credits with omitted leading zeros join the complete same-day batch", () => {
  const fractional = [".88", ".01", "0.88"].map((amount, index) => ({
    ...records[0], transaction_id: `fractional-${index}`,
    name: `APA TREAS 310 MISC PAY~ Future Amount: ${amount} ~ Tran: DDIR`,
    amount: -Number(amount),
  }));
  for (const input of [[...records, ...fractional], [...fractional, ...records].reverse()]) {
    const groups = groupInternalTransfers(input, [account]);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].type, "treasury-payment");
    assert.deepEqual(groups[0].transactions, input);
    assert.equal(getTransactionGroupAmount(groups[0]), 218.53);
    const html = renderTransactionList(input, [account]);
    assert.match(html, /Bond payments · 12 transactions/);
    assert.match(html, /class="transfer-pair-amount">\$218\.53/);
    for (const original of fractional) assert.ok(html.includes(original.name));
  }
});

test("Overview takes five recent groups only after collecting the full TreasuryDirect batch", () => {
  assert.equal(typeof transactionList.renderRecentTransactionList, "function");
  const purchases = Array.from({ length: 6 }, (_, index) => ({
    ...records[0], transaction_id: `purchase-${index}`, name: `Purchase ${index}`,
    date: `2026-10-${String(25 - index).padStart(2, "0")}`, amount: 10,
  }));
  const input = [...purchases, ...records].reverse();
  const before = structuredClone(input);
  const html = transactionList.renderRecentTransactionList(input, [account]);
  assert.match(html, /Bond payments · 9 transactions/);
  assert.match(html, /class="transfer-pair-amount">\$216\.76/);
  assert.equal((html.match(/class="account-row transaction-row"/g) ?? []).length, 13);
  assert.ok(html.indexOf("TreasuryDirect → Bonds") < html.indexOf("Purchase 0"));
  assert.match(html, /Purchase 3/);
  assert.doesNotMatch(html, /Purchase 4|Purchase 5/);
  assert.deepEqual(input, before);
});

test("TreasuryDirect search matches the displayed batch total as well as original payments", () => {
  const groups = groupInternalTransfers(records, [account]);
  const filters = {
    includeAccountIds: [account.id], excludeAccountIds: [],
    minimumAmount: 200, maximumAmount: 220, sort: "amount-desc",
  };
  for (const searchQuery of ["$216.76", "216.76", " TreasuryDirect ", "bond payments", "Original payments", "Future Amount: 37.13", "Ally", "Bonds"]) {
    const matches = filterAndSortTransactionGroups(groups, [account], { ...filters, searchQuery });
    assert.deepEqual(matches, groups, searchQuery);
    assert.strictEqual(matches[0], groups[0]);
    assert.equal(matches[0].transactions.length, 9);
  }
  for (const overrides of [
    { includeAccountIds: [] }, { includeAccountIds: ["other"] },
    { excludeAccountIds: [account.id] }, { maximumAmount: 216.75 },
    { minimumAmount: 216.77 }, { searchQuery: "interest" }, { searchQuery: "not found" },
  ]) assert.deepEqual(filterAndSortTransactionGroups(groups, [account], { ...filters, ...overrides }), []);
});

test("account details limit to fifty summaries without cutting a large same-day batch", () => {
  const payments = Array.from({ length: 55 }, (_, index) => ({ ...records[0], transaction_id: `large-${index}` }));
  const purchases = Array.from({ length: 50 }, (_, index) => ({
    ...records[0], transaction_id: `older-${index}`, name: `Older purchase ${index}`, date: "2026-10-01", amount: 10,
  }));
  const html = renderAccountDetail(account, [...payments, ...purchases], [account]);
  assert.match(html, /Bond payments · 55 transactions/);
  assert.equal((html.match(/class="account-row transaction-row"/g) ?? []).length, 104);
  assert.match(html, /Older purchase 48/);
  assert.doesNotMatch(html, /Older purchase 49/);
});

test("TreasuryDirect batches never cross receiving accounts, dates or currencies and keep repeated payments", () => {
  const other = { ...account, id: "other", providerAccountId: "other-bonds", name: "Other bonds" };
  const pairs = [
    [records[0], records[1]],
    [records[2], records[3]].map(record => ({ ...record, account_id: other.providerAccountId })),
    [records[4], records[5]].map(record => ({ ...record, date: "2026-11-03" })),
    [records[6], records[7]].map(record => ({ ...record, iso_currency_code: "EUR" })),
  ];
  const input = [pairs[0][0], pairs[1][0], pairs[2][0], pairs[3][0], ...pairs.map(pair => pair[1]), records[8]];
  const before = structuredClone(input);
  const groups = groupInternalTransfers(input, [account, other]);
  assert.equal(groups.length, 4);
  assert.deepEqual(groups.map(group => group.transactions.length), [3, 2, 2, 2]);
  assert.equal(new Set(groups.flatMap(group => group.transactions.map(record => record.transaction_id))).size, 9);
  for (const group of groups) {
    assert.equal(group.type, "treasury-payment");
    assert.equal(new Set(group.transactions.map(record => record.account_id)).size, 1);
    assert.equal(new Set(group.transactions.map(record => record.date)).size, 1);
    assert.equal(new Set(group.transactions.map(record => record.iso_currency_code)).size, 1);
  }
  assert.deepEqual(input, before);
  const duplicates = [records[3], records[4]];
  assert.equal(groupInternalTransfers(duplicates, [account])[0].transactions.length, 2);
  assert.equal(getTransactionGroupAmount(groupInternalTransfers(duplicates, [account])[0]), 23.12);
});

test("only posted incoming TreasuryDirect descriptors with known receiving accounts qualify", () => {
  for (const overrides of [
    { amount: 45.38 }, { amount: 0 }, { amount: NaN }, { amount: Infinity }, { amount: null },
    { pending: true }, { account_id: "unknown" }, { account_id: null },
    { iso_currency_code: null }, { date: null }, { date: "invalid" }, { date: "2026-02-30" },
    { name: "IRS TREAS 310 TAX REF" }, { name: "TREAS 310 MISC PAY" },
    { name: "SSA TREAS 310 XXSOC SEC" }, { name: "Unrelated APA TREAS 310 MISC PAY" },
    { name: records[0].name + " unrelated" }, { name: null },
  ]) {
    const invalid = records.slice(0, 2).map(record => ({ ...record, ...overrides }));
    assert.deepEqual(groupInternalTransfers(invalid, [account]).map(group => group.type), ["single", "single"], JSON.stringify(overrides));
  }
  assert.equal(groupInternalTransfers([records[0]], [account])[0].type, "single");
  assert.ok(groupInternalTransfers(records, [{ ...account, type: "credit" }]).every(group => group.type === "single"));
  const variation = records.slice(0, 2).map(record => ({
    ...record, name: record.name.toLowerCase().replace("apa treas", "  apa   treas") + "  ",
    iso_currency_code: null, unofficial_currency_code: "USD",
  }));
  assert.equal(groupInternalTransfers(variation, [account])[0].type, "treasury-payment");
  const html = renderTransactionList(records, [{ ...account, name: '<img src=x onerror="alert(1)">' }]);
  assert.match(html, /TreasuryDirect → &lt;img/);
  assert.doesNotMatch(html, /<img/);
});
