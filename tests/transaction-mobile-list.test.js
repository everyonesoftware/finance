import test from 'node:test';
import assert from 'node:assert/strict';
import { groupInternalTransfers, renderTransactionGroups, renderTransactionList } from '../src/transaction-list.ts';

const accounts = [
  { id: 'checking', providerAccountId: 'checking-provider', name: 'Checking', institutionName: 'Bank', mask: '1257', type: 'depository' },
  { id: 'savings', providerAccountId: 'savings-provider', name: 'Savings', institutionName: 'Bank', mask: '4753', type: 'depository' },
];
const transaction = (name, date = '2026-11-10', extra = {}) => ({ name, date, amount: 12, iso_currency_code: 'USD', account_id: 'checking-provider', ...extra });
const single = (name, date, extra) => ({ type: 'single', transactions: [transaction(name, date, extra)] });
const headings = (html) => [...html.matchAll(/<h3 class="transaction-date-heading">([\s\S]*?)<\/h3>/g)].map(match => match[1]);

test('activity rows use local monograms, a pending badge and green income without altering descriptions', () => {
  const name = '<Coffee & "tea"> complete original description 123456789';
  const escaped = '&lt;Coffee &amp; &quot;tea&quot;&gt; complete original description 123456789';
  const specialAccounts = [{ ...accounts[0], name: '<Checking>', institutionName: 'Bank & Co' }];
  const groups = [single(name, '2026-11-10', { pending: true }), single('Payroll', '2026-11-10', { amount: -250 })];
  const html = renderTransactionGroups(groups, specialAccounts, { groupByDate: true, showAccount: true });
  assert.match(html, /class="account-row transaction-row" data-activity="true"/);
  assert.match(html, /class="transaction-avatar" aria-hidden="true">&lt;<\/span>/);
  assert.ok(html.includes(`<strong>${escaped}</strong>`));
  assert.match(html, /transaction-account-label">Bank &amp; Co · &lt;Checking&gt;<\/span>/);
  assert.match(html, /class="transaction-pending">Pending<\/span>/);
  assert.match(html, /<b class="transaction-income">\$250\.00<\/b>/);
  assert.match(html, /<b>-\$12\.00<\/b>/);
  assert.doesNotMatch(html, /<img|<Coffee|2026-11-10 · Pending/);
  assert.equal((html.match(/2026-11-10/g) ?? []).length, 1);
  assert.doesNotMatch(renderTransactionGroups(groups, specialAccounts, { groupByDate: true }), /transaction-account-label/);
  const legacy = renderTransactionGroups(groups, specialAccounts, { showAccount: true });
  assert.doesNotMatch(legacy, /transaction-avatar|transaction-pending|transaction-income|transaction-activity-row/);
  assert.match(legacy, /2026-11-10 · Pending/);
  assert.ok(legacy.includes(`<strong>${escaped}</strong>`));
});

test('activityStyle keeps monograms and badges when amount sort disables date headings', () => {
  const html = renderTransactionGroups([single('Salary', '2026-11-10', { amount: -40, pending: true })], accounts, { activityStyle: true, showAccount: true });
  assert.doesNotMatch(html, /transaction-date-heading/);
  assert.match(html, /class="account-row transaction-row" data-activity="true"/);
  assert.match(html, /class="transaction-avatar" aria-hidden="true">S<\/span>/);
  assert.match(html, /class="transaction-pending">Pending<\/span>/);
  assert.match(html, /class="transaction-income">\$40\.00/);
  assert.match(html, /transaction-account-label/);
  assert.match(html, /<span>2026-11-10<\/span>/);
});

test('date sections render one heading per consecutive day without sorting or mutating groups', () => {
  const groups = [single('First', '2026-11-09'), single('Second', '2026-11-09'), single('Third', '2026-11-10')];
  const original = structuredClone(groups);
  const html = renderTransactionGroups(groups, accounts, { groupByDate: true });
  assert.deepEqual(headings(html), ['2026-11-09', '2026-11-10']);
  assert.ok(html.indexOf('First') < html.indexOf('Second'));
  assert.ok(html.indexOf('Second') < html.indexOf('Third'));
  assert.deepEqual(groups, original);
  assert.doesNotMatch(renderTransactionGroups(groups, accounts), /transaction-date-heading|transaction-avatar|transaction-activity-row/);
  assert.equal(renderTransactionGroups([], accounts, { groupByDate: true }), 'No saved transactions are available.');
});

test('date headings use a transfer’s earliest date and preserve original linked rows and positive amount', () => {
  const originals = [
    transaction('Internet transfer to Savings account XXXXXX4753 <original>', '2026-11-10', { amount: 50 }),
    transaction('Internet transfer from Checking account XXXXXX1257 & original', '2026-11-09', { account_id: 'savings-provider', amount: -50 }),
  ];
  const groups = groupInternalTransfers(originals, accounts);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].type, 'transfer');
  const legacy = renderTransactionGroups(groups, accounts, { showAccount: true });
  const html = renderTransactionGroups(groups, accounts, { groupByDate: true, showAccount: true, activityStyle: true });
  assert.deepEqual(headings(html), ['2026-11-09']);
  assert.equal(html.replace(/<h3 class="transaction-date-heading">[\s\S]*?<\/h3>/, ''), legacy);
  assert.match(html, /<details class="transaction-transfer-pair">/);
  assert.match(html, /class="transfer-pair-amount">\$50\.00/);
  assert.match(html, /class="transfer-pair-rows"/);
  assert.match(html, /href="\/accounts\/savings">Savings account XXXXXX4753<\/a> &lt;original&gt;/);
  assert.match(html, /href="\/accounts\/checking">Checking account XXXXXX1257<\/a> &amp; original/);
  assert.match(html, /2026-11-09 – 2026-11-10/);
  assert.deepEqual(headings(renderTransactionGroups(groups, accounts, { groupByDate: true, previousDate: '2026-11-09' })), []);
  assert.equal(renderTransactionList(originals, accounts, { groupByDate: true, showAccount: true }), html);
});

test('date heading values and unavailable fields remain safe to render', () => {
  const html = renderTransactionGroups([single('Untrusted', '<img src=x onerror="alert(1)">'), { type: 'single', transactions: [{}] }], accounts, { groupByDate: true });
  assert.deepEqual(headings(html), ['&lt;img src=x onerror=&quot;alert(1)&quot;&gt;', 'Date unavailable']);
  assert.doesNotMatch(html, /<img|transaction-income|transaction-pending/);
  assert.match(html, /<strong>Transaction<\/strong>/);
  assert.match(html, /<b>—<\/b>/);
});

test('appended sections continue previousDate only until the day changes', () => {
  const groups = [single('Continued', '2026-11-10'), single('Older', '2026-11-09'), single('Return', '2026-11-10')];
  assert.deepEqual(headings(renderTransactionGroups(groups, accounts, { groupByDate: true, previousDate: '2026-11-10' })), ['2026-11-09', '2026-11-10']);
  assert.deepEqual(headings(renderTransactionGroups(groups, accounts, { groupByDate: true, previousDate: '2026-11-08' })), ['2026-11-10', '2026-11-09', '2026-11-10']);
  assert.deepEqual(headings(renderTransactionGroups([single('No date', null)], accounts, { groupByDate: true })), ['Date unavailable']);
  assert.deepEqual(headings(renderTransactionGroups([single('No date', null)], accounts, { groupByDate: true, previousDate: null })), []);
  assert.deepEqual(headings(renderTransactionGroups(groups, accounts, { previousDate: '2026-11-10' })), []);
});
