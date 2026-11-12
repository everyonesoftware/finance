import assert from 'node:assert/strict';
import test from 'node:test';
import { groupInternalTransfers, renderRecentTransactionList, renderTransactionGroups } from '../src/transaction-list.ts';
import { filterAndSortTransactionGroups, getTransactionGroupDate } from '../src/transaction-filters.ts';

const accounts = [
  { id: 'checking', providerAccountId: 'checking', name: 'Checking', institutionName: 'Bank', type: 'depository', subtype: 'checking', mask: '1234' },
  { id: 'card', providerAccountId: 'card', name: 'Card', institutionName: 'Citi', type: 'credit', subtype: 'credit card' },
];
const transaction = (name, date, extra = {}) => ({ name, date, amount: 10, account_id: 'checking', iso_currency_code: 'USD', ...extra });
const records = [
  transaction('Old purchase', '2026-11-01'),
  transaction('CITI CARD ONLINE PAYMENT', '2026-11-08', { amount: 100 }),
  transaction('Middle purchase', '2026-11-09'),
  transaction('ONLINE PAYMENT, THANK YOU', '2026-11-10', { amount: -100, account_id: 'card' }),
  transaction('Newest purchase', '2026-11-11'),
];
const filters = { includeAccountIds: accounts.map(account => account.id), excludeAccountIds: [], minimumAmount: -Infinity, maximumAmount: Infinity };

test('group date is the maximum child date regardless of group type or child order', () => {
  const originals = [transaction('Earlier', '2026-11-08'), transaction('Later', '2026-11-10'), transaction('Missing', null), transaction('Empty', '')];
  for (const type of ['transfer', 'credit-card-payment', 'treasury-payment', 'travel-reward']) {
    for (const transactions of [originals, [...originals].reverse()]) {
      assert.equal(getTransactionGroupDate({ type, transactions }), '2026-11-10');
    }
  }
  assert.equal(getTransactionGroupDate({ type: 'single', transactions: [transaction('Missing', null)] }), null);
});

test('both date sorts place complete groups by their newest child, not their oldest or first child', () => {
  for (const input of [records, [...records].reverse()]) {
    const before = structuredClone(input);
    const groups = groupInternalTransfers(input, accounts);
    const label = group => group.type === 'single' ? group.transactions[0].name : group.type;
    assert.deepEqual(filterAndSortTransactionGroups(groups, accounts, { ...filters, sort: 'date-desc' }).map(label),
      ['Newest purchase', 'credit-card-payment', 'Middle purchase', 'Old purchase']);
    assert.deepEqual(filterAndSortTransactionGroups(groups, accounts, { ...filters, sort: 'date-asc' }).map(label),
      ['Old purchase', 'Middle purchase', 'credit-card-payment', 'Newest purchase']);
    assert.deepEqual(input, before);
  }
});

test('Overview sorts newest first before limiting complete groups and leaves inputs untouched', () => {
  for (const input of [records, [...records].reverse()]) {
    const before = structuredClone(input);
    const html = renderRecentTransactionList(input, accounts, 3);
    const labels = [...html.matchAll(/<strong>([^<]+)<\/strong>/g)].map(match => match[1]);
    assert.deepEqual(labels, ['Newest purchase', 'Checking → Card', 'ONLINE PAYMENT, THANK YOU', 'CITI CARD ONLINE PAYMENT', 'Middle purchase']);
    assert.match(html, /2026-11-08 – 2026-11-10/);
    assert.doesNotMatch(html, /Old purchase/);
    assert.deepEqual(input, before);
  }
});

test('date headings use the same maximum date as group sorting while summaries preserve the range', () => {
  const group = groupInternalTransfers(records, accounts).find(group => group.type === 'credit-card-payment');
  const html = renderTransactionGroups([group], accounts, { groupByDate: true });
  assert.match(html, /<h3 class="transaction-date-heading">2026-11-10<\/h3>/);
  assert.match(html, /2026-11-08 – 2026-11-10/);
});
