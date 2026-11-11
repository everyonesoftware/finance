import assert from 'node:assert/strict';
import test from 'node:test';
import { groupInternalTransfers, renderTransactionList } from '../src/transaction-list.ts';
import { filterAndSortTransactionGroups, getTransactionGroupAmount } from '../src/transaction-filters.ts';
import { renderAccountDetail } from '../src/bank_accounts.ts';

const accounts = [
  { id: 'spending', providerAccountId: 'ally-spending', institutionName: 'Ally', name: 'Camilla Spending', type: 'depository', subtype: 'checking', currencyCode: 'USD' },
  { id: 'costco', providerAccountId: 'citi-costco', institutionName: 'Citi', name: 'Costco Card', type: 'credit', subtype: 'credit card', currencyCode: 'USD' },
];
const records = [
  { transaction_id: 'bank-payment', account_id: 'ally-spending', name: 'CITI CARD ONLINE PAYMENT', date: '2026-11-10', amount: 646.67, iso_currency_code: 'USD', pending: false },
  { transaction_id: 'card-payment', account_id: 'citi-costco', name: 'ONLINE PAYMENT, THANK YOU', date: '2026-11-09', amount: -646.67, iso_currency_code: 'USD', pending: false },
];

const capitalOneAccounts = [
  accounts[0],
  { ...accounts[1], id: 'capital-one', providerAccountId: 'capital-one-card', institutionName: 'CapitalOne', name: 'CapitalOne Card' },
];
const capitalOneRecords = [
  { ...records[0], transaction_id: 'capital-one-withdrawal', name: 'CAPITAL ONE ONLINE PMT', date: '2026-11-09', amount: 679.86 },
  { ...records[1], transaction_id: 'capital-one-credit', account_id: 'capital-one-card', name: 'CAPITAL ONE ONLINE PYMT CAPITAL ONE ONLINE PYMT', amount: -679.86 },
];

test('the supplied Capital One payment becomes one expandable group in either input order', () => {
  const before = structuredClone(capitalOneRecords);
  for (const originals of [capitalOneRecords, [...capitalOneRecords].reverse()]) {
    const groups = groupInternalTransfers(originals, capitalOneAccounts);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].type, 'credit-card-payment');
    assert.equal(groups[0].fromAccount.id, 'spending');
    assert.equal(groups[0].toAccount.id, 'capital-one');
    assert.deepEqual(groups[0].transactions, originals);
    assert.equal(getTransactionGroupAmount(groups[0]), 679.86);
    const html = renderTransactionList(originals, capitalOneAccounts, { showAccount: true });
    assert.match(html, /Credit Card Payment: Camilla Spending → CapitalOne Card/);
    assert.match(html, /class="transfer-pair-amount">\$679\.86/);
    assert.match(html, /CAPITAL ONE ONLINE PMT/);
    assert.match(html, /CAPITAL ONE ONLINE PYMT CAPITAL ONE ONLINE PYMT/);
    assert.match(html, /Transactions included in this credit card payment/);
    assert.equal((html.match(/class="account-row transaction-row"/g) ?? []).length, 2);
  }
  assert.deepEqual(capitalOneRecords, before);
});

test('same-sized payments match only within their issuer even on the same day', () => {
  const availableAccounts = [...accounts, capitalOneAccounts[1]];
  const citiRecords = records.map(record => ({ ...record, date: '2026-11-09', amount: record.amount > 0 ? 679.86 : -679.86 }));
  const originals = [citiRecords[0], ...capitalOneRecords, citiRecords[1]];
  for (const input of [originals, [...originals].reverse()]) {
    const groups = groupInternalTransfers(input, availableAccounts);
    assert.equal(groups.length, 2);
    assert.ok(groups.every(group => group.type === 'credit-card-payment'));
    assert.deepEqual(groups.find(group => group.toAccount.id === 'costco').transactions.map(record => record.transaction_id).sort(), ['bank-payment', 'card-payment']);
    assert.deepEqual(groups.find(group => group.toAccount.id === 'capital-one').transactions.map(record => record.transaction_id).sort(), ['capital-one-credit', 'capital-one-withdrawal']);
  }
  for (const input of [[citiRecords[0], capitalOneRecords[1]], [capitalOneRecords[0], citiRecords[1]]]) {
    assert.ok(groupInternalTransfers(input, availableAccounts).every(group => group.type === 'single'));
  }
});

test('Capital One retains amount, currency, date, direction, account-type and pending safeguards', () => {
  for (const overrides of [
    { amount: -679.85 }, { amount: 679.86 }, { amount: 0 }, { amount: Infinity },
    { iso_currency_code: 'EUR' }, { iso_currency_code: null },
    { date: '2026-11-15' }, { date: '2026-11-03' }, { date: 'invalid' },
    { pending: true }, { name: 'CAPITAL ONE REFUND' }, { account_id: 'unknown' },
  ]) {
    const originals = [capitalOneRecords[0], { ...capitalOneRecords[1], ...overrides }];
    assert.deepEqual(groupInternalTransfers(originals, capitalOneAccounts).map(group => group.type), ['single', 'single']);
  }
  for (const overrides of [{ institutionName: 'Citi' }, { institutionName: 'Other Bank' }, { type: 'depository' }, { subtype: 'loan' }]) {
    const availableAccounts = [capitalOneAccounts[0], { ...capitalOneAccounts[1], ...overrides }];
    assert.deepEqual(groupInternalTransfers(capitalOneRecords, availableAccounts).map(group => group.type), ['single', 'single']);
  }
  assert.equal(groupInternalTransfers([capitalOneRecords[0]], capitalOneAccounts)[0].type, 'single');
  assert.equal(groupInternalTransfers([capitalOneRecords[1]], capitalOneAccounts)[0].type, 'single');
  assert.deepEqual(groupInternalTransfers([{ ...capitalOneRecords[0], pending: true }, capitalOneRecords[1]], capitalOneAccounts).map(group => group.type), ['single', 'single']);
});

test('Capital One permits formatting variations and five-day posting differences without hardcoding the amount', () => {
  for (const institutionName of ['CapitalOne', ' Capital One ']) {
    const availableAccounts = [capitalOneAccounts[0], { ...capitalOneAccounts[1], institutionName }];
    for (const date of ['2026-11-04', '2026-11-14']) {
      const originals = [
        { ...capitalOneRecords[0], name: ' capital  one online pmt ', amount: 100 },
        { ...capitalOneRecords[1], name: ' capital one online pymt\ncapital one online pymt ', date, amount: -100 },
      ];
      assert.equal(groupInternalTransfers(originals, availableAccounts)[0].type, 'credit-card-payment');
    }
  }
});

test('Capital One leaves equal-sized ambiguous payments separate from either direction', () => {
  for (const record of capitalOneRecords) {
    const originals = [...capitalOneRecords, { ...record, transaction_id: `${record.transaction_id}-duplicate` }];
    for (const input of [originals, [...originals].reverse()]) {
      assert.deepEqual(groupInternalTransfers(input, capitalOneAccounts).map(group => group.type), ['single', 'single', 'single']);
    }
  }
  const groups = groupInternalTransfers(capitalOneRecords, capitalOneAccounts);
  const filters = { includeAccountIds: ['capital-one'], excludeAccountIds: [], minimumAmount: 600, maximumAmount: 700, sort: 'date-desc' };
  assert.equal(filterAndSortTransactionGroups(groups, capitalOneAccounts, filters).length, 1);
  assert.match(renderAccountDetail(capitalOneAccounts[1], capitalOneRecords, capitalOneAccounts), /Credit Card Payment: Camilla Spending → CapitalOne Card/);
});

// Stored amounts are positive for money leaving an account; display signs are inverted.
test('the supplied Ally and Citi payment becomes one expandable credit card payment', () => {
  const before = structuredClone(records);
  for (const originals of [records, [...records].reverse()]) {
    const groups = groupInternalTransfers(originals, accounts);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].type, 'credit-card-payment');
    assert.equal(groups[0].fromAccount.id, 'spending');
    assert.equal(groups[0].toAccount.id, 'costco');
    assert.deepEqual(groups[0].transactions, originals);
    const html = renderTransactionList(originals, accounts, { showAccount: true });
    assert.match(html, /<details class="transaction-transfer-pair">/);
    assert.match(html, /Credit Card Payment: Camilla Spending → Costco Card/);
    assert.match(html, /Expand or collapse original credit card payment transactions/);
    assert.match(html, /Transactions included in this credit card payment/);
    assert.match(html, /2026-11-09 – 2026-11-10/);
    assert.match(html, /class="transfer-pair-amount">\$646\.67/);
    assert.match(html, /CITI CARD ONLINE PAYMENT/);
    assert.match(html, /ONLINE PAYMENT, THANK YOU/);
    assert.equal((html.match(/class="account-row transaction-row"/g) ?? []).length, 2);
  }
  assert.deepEqual(records, before);
});

test('payment amount and account filters treat the group like a transfer in either input order', () => {
  for (const originals of [records, [...records].reverse()]) {
    const groups = groupInternalTransfers(originals, accounts);
    assert.equal(getTransactionGroupAmount(groups[0]), 646.67);
    const filters = { includeAccountIds: ['spending'], excludeAccountIds: [], minimumAmount: 600, maximumAmount: 700, sort: 'date-desc' };
    assert.equal(filterAndSortTransactionGroups(groups, accounts, filters).length, 1);
    assert.equal(filterAndSortTransactionGroups(groups, accounts, { ...filters, includeAccountIds: ['costco'] }).length, 1);
    assert.equal(filterAndSortTransactionGroups(groups, accounts, { ...filters, excludeAccountIds: ['costco'] }).length, 0);
    assert.equal(filterAndSortTransactionGroups(groups, accounts, { ...filters, includeAccountIds: [] }).length, 0);
    assert.equal(filterAndSortTransactionGroups(groups, accounts, { ...filters, maximumAmount: 600 }).length, 0);
  }
});

test('Citi payments tolerate casing and spacing, use a five-day window and do not hardcode the example amount', () => {
  for (const date of ['2026-11-05', '2026-11-10', '2026-11-15']) {
    const originals = [
      { ...records[0], name: ' citi  card online payment ', amount: 123.45 },
      { ...records[1], name: 'online payment, thank you', date, amount: -123.45 },
    ];
    assert.equal(groupInternalTransfers(originals, accounts)[0].type, 'credit-card-payment');
  }
});

test('unsupported, missing, pending, reversed and mismatching payment records remain separate', () => {
  const cases = [
    [records.slice(0, 1), accounts], [records.slice(1), accounts],
    [[{ ...records[0], pending: true }, records[1]], accounts],
    [[records[0], { ...records[1], pending: true }], accounts],
    [[{ ...records[0], amount: -646.67 }, { ...records[1], amount: 646.67 }], accounts],
    [[records[0], { ...records[1], amount: 646.67 }], accounts],
    [[records[0], { ...records[1], amount: -646.66 }], accounts],
    [[records[0], { ...records[1], iso_currency_code: 'EUR' }], accounts],
    [[records[0], { ...records[1], iso_currency_code: null }], accounts],
    [[records[0], { ...records[1], date: '2026-11-04' }], accounts],
    [[records[0], { ...records[1], date: '2026-11-16' }], accounts],
    [[records[0], { ...records[1], date: 'invalid' }], accounts],
    [[{ ...records[0], date: '2026-03-01' }, { ...records[1], date: '2026-02-30' }], accounts],
    [[records[0], { ...records[1], name: 'MERCHANT REFUND' }], accounts],
    [[{ ...records[0], name: 'OTHER BANK ONLINE PAYMENT' }, records[1]], accounts],
    [[records[0], { ...records[1], account_id: 'unknown' }], accounts],
    [[records[0], { ...records[1], account_id: 'ally-spending' }], accounts],
    [records, [accounts[0], { ...accounts[1], institutionName: 'Other Bank' }]],
    [records, [accounts[0], { ...accounts[1], type: 'loan', subtype: 'loan' }]],
    [records, [{ ...accounts[0], type: 'investment' }, accounts[1]]],
    [[{ ...records[0], amount: 0 }, { ...records[1], amount: 0 }], accounts],
    [[{ ...records[0], amount: NaN }, records[1]], accounts],
  ];
  cases.forEach(([originals, availableAccounts], index) => {
    const groups = groupInternalTransfers(originals, availableAccounts);
    assert.equal(groups.length, originals.length, `case ${index}`);
    assert.ok(groups.every(group => group.type === 'single'), `case ${index}`);
  });
});

test('ambiguous payment matches stay separate on both sides regardless of order', () => {
  const otherCard = { ...accounts[1], id: 'other-card', providerAccountId: 'other-citi-card', name: 'Other Citi Card' };
  const otherBank = { ...accounts[0], id: 'other-bank', providerAccountId: 'other-bank' };
  const availableAccounts = [...accounts, otherCard, otherBank];
  for (const extra of [
    { ...records[0], transaction_id: 'second-withdrawal' },
    { ...records[1], transaction_id: 'second-credit' },
    { ...records[1], transaction_id: 'other-card-credit', account_id: otherCard.providerAccountId },
    { ...records[0], transaction_id: 'other-bank-withdrawal', account_id: otherBank.providerAccountId },
  ]) {
    for (const originals of [[...records, extra], [extra, ...records].reverse()]) {
      assert.deepEqual(groupInternalTransfers(originals, availableAccounts).map(group => group.type), ['single', 'single', 'single']);
    }
  }
});

test('independent payments are consumed once and account details use the shared grouped renderer', () => {
  const originals = [...records, ...records.map(record => ({ ...record, transaction_id: `${record.transaction_id}-later`, date: '2026-11-20' }))];
  const groups = groupInternalTransfers(originals, accounts);
  assert.equal(groups.length, 2);
  assert.ok(groups.every(group => group.type === 'credit-card-payment'));
  assert.equal(new Set(groups.flatMap(group => group.transactions.map(record => record.transaction_id))).size, 4);
  const html = renderAccountDetail(accounts[0], records, accounts);
  assert.match(html, /Credit Card Payment: Camilla Spending → Costco Card/);
  assert.equal((html.match(/<details class="transaction-transfer-pair">/g) ?? []).length, 1);
});
