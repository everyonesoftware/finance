import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import * as bank from '../src/bank_accounts.ts';
import { renderDashboard } from '../src/dashboard.ts';
import { renderTransactionsPage } from '../src/transactions-page.ts';
import { renderTransactionList } from '../src/transaction-list.ts';

const notice = 'Add accounts manually and import CSV, OFX, or QFX transactions. Automatic bank syncing is unavailable; previously saved data remains available.';
const user = { displayName: 'Offline User', username: 'offline' };
const account = { id: 'saved-1', providerAccountId: 'saved-1', itemId: 'saved-item', institutionName: 'Saved Bank', name: 'Saved Checking', officialName: null, type: 'depository', subtype: 'checking', mask: '1234', currentBalance: 125, availableBalance: 100, currencyCode: 'USD', updatedAt: '2026-01-01T00:00:00Z' };
const transaction = { id: 'tx-1', account_id: account.id, name: 'Saved purchase', amount: 12, date: '2026-01-01' };

test('overview omits introductory copy and the bank-data notice', () => {
  const html = renderDashboard(user);
  assert.doesNotMatch(html, /Here’s what’s happening with your money\./);
  assert.ok(!html.includes(notice));
  assert.doesNotMatch(html, /class="(?:subheading|bank-data-notice)"/);
  assert.doesNotMatch(html, /Welcome,|✳|class="page-heading"/);
  assert.doesNotMatch(html, /class="eyebrow"/);
  assert.match(html, /aria-label="Financial summary"/);
});

test('account details omit redundant copy and links without removing account content', () => {
  const shell = bank.renderBankAccountDetailPage(user);
  const detail = bank.renderAccountDetail({ ...account, canImport: true }, [transaction]);
  assert.doesNotMatch(shell, /YOUR ACCOUNT|Account balances and transaction history\.|>All accounts<|bank-data-notice/);
  assert.ok(!shell.includes(notice));
  assert.doesNotMatch(detail, /← Back to accounts/);
  assert.match(shell, /<h1>Account details<\/h1>/);
  assert.match(detail, /<h1>Saved Checking<\/h1>/);
  assert.match(detail, /Current balance/);
  assert.match(detail, /Saved purchase/);
  assert.match(detail, /id="import-transactions"/);
});

test('Accounts keeps the add control and list without introductory copy', () => {
  const html = bank.renderBankAccountsPage(user);
  assert.match(html, /<h1\b[^>]*>Accounts<\/h1>/);
  assert.match(html, /id="add-account"/);
  assert.match(html, /id="connected-accounts"/);
  assert.doesNotMatch(html, /YOUR FINANCES|Your accounts, balances, and imported activity\.|Automatic bank syncing is unavailable/);
});

test('Real Estate keeps the add control and list without introductory copy', () => {
  const html = bank.renderConnectionsPage(user);
  assert.match(html, /<h1>Real Estate<\/h1>/);
  assert.match(html, /id="add-property"/);
  assert.match(html, /id="real-estate-properties"/);
  assert.doesNotMatch(html, /YOUR FINANCES|Track property values and estimate history\./);
});

test('bank surfaces display saved data without bank mutation controls or setup prompts', () => {
  for (const html of [renderDashboard(user), bank.renderBankAccountsPage(user), bank.renderBankAccountDetailPage(user), renderTransactionsPage(user)]) {
    assert.ok(!html.includes(notice));
    assert.doesNotMatch(html, /(?:id="(?:sync-|connect-bank)|>\s*(?:Connect (?:a bank|an account)|Sync transactions)|Configure .*Settings)/i);
  }
  for (const html of [bank.renderAccounts([account]), bank.renderConnections([{ itemId: account.itemId, institutionName: account.institutionName, lastRetrievedAt: account.updatedAt, accountCount: 1, accounts: [account] }]), bank.renderAccountDetail(account, [transaction])]) {
    assert.match(html, /Saved Checking/);
    assert.doesNotMatch(html, /<button|disconnect|synchroniz|data-connection-type=/i);
  }
  for (const html of [bank.renderAccounts([]), bank.renderConnections([]), bank.renderOverviewBankAccounts([]), renderTransactionList([], [])]) assert.doesNotMatch(html, /connect (?:a bank|an account|an institution)|sync to|sync transactions/i);
});

class Element {
  value = ''; textContent = ''; hidden = false; disabled = false; dataset = {}; handlers = {}; checked = true;
  style = { setProperty() {} }; classList = { toggle() {}, add() {}, remove() {} };
  children = []; html = '';
  set innerHTML(value) {
    this.html = value;
    if (value.includes('data-account-filter')) this.children = [Object.assign(new Element(), { value: account.id, checked: true })];
  }
  get innerHTML() { return this.html; }
  addEventListener(name, handler) { (this.handlers[name] ??= []).push(handler); }
  async emit(name, extra = {}) { for (const handler of this.handlers[name] ?? []) await handler({ preventDefault() {}, currentTarget: this, target: this, ...extra }); }
  querySelector() { return null; }
  querySelectorAll(selector) { return selector.startsWith('input[') ? this.children.filter(c => !selector.includes(':checked') || c.checked) : []; }
  setAttribute() {} focus() {}
}
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
function dom(selectors) {
  const nodes = Object.fromEntries(selectors.map(selector => [selector, new Element()]));
  globalThis.document = { querySelector: selector => nodes[selector] ?? null, querySelectorAll: selector => selector.includes('bank') || selector.includes('sync') ? [nodes['#connect-bank']] .filter(Boolean) : [], addEventListener() {} };
  globalThis.window = { confirm: () => true };
  globalThis.location = { search: '' };
  return nodes;
}
test('saved accounts and detail initialize with GET only and ignore obsolete action nodes', async () => {
  const nodes = dom(['#connected-accounts', '#overview-bank-accounts', '#overview-total-balance', '#account-detail-content', '#connect-bank', '#sync-all-institutions', '#sync-account-transactions', '#accounts-message']);
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push([url, options.method ?? 'GET']);
    return { ok: true, json: async () => url.endsWith('/transactions') ? { configured: false, account, accounts: [account], transactions: [transaction] } : { configured: false, accounts: [account] } };
  };
  bank.initializeBankAccountsPage(); await settle();
  await bank.initializeOverviewBankAccounts();
  await bank.initializeAccountDetailPage(account.id);
  for (const id of ['#connect-bank', '#sync-all-institutions', '#sync-account-transactions']) await nodes[id].emit('click');
  await settle();
  assert.match(nodes['#connected-accounts'].innerHTML, /Saved Checking/);
  assert.match(nodes['#overview-bank-accounts'].innerHTML, /Saved Checking/);
  assert.match(nodes['#account-detail-content'].innerHTML, /Saved purchase/);
  assert.deepEqual(calls, [['/api/accounts', 'GET'], ['/api/accounts', 'GET'], ['/api/accounts/saved-1/transactions', 'GET']]);
});
test('transactions load while unconfigured and filter locally without syncing', async () => {
  const { initializeTransactionsPage } = await import('../src/transactions-page.ts');
  const html = renderTransactionsPage(user);
  const ids = [...html.matchAll(/id="([^" ]+)"/g)].map(match => '#' + match[1]);
  const nodes = dom([...ids, '#sync-all-transactions']);
  nodes['#transaction-sort-order'].value = 'date-desc';
  const calls = [];
  globalThis.fetch = async (url, options = {}) => { calls.push([url, options.method ?? 'GET']); return { ok: true, json: async () => ({ configured: false, accounts: [account], transactions: [transaction] }) }; };
  await initializeTransactionsPage();
  assert.match(nodes['#all-transactions-list'].innerHTML, /Saved purchase/, nodes['#all-transactions-list'].textContent);
  assert.equal(nodes['#all-transactions-status'].textContent, '');
  assert.equal(nodes['#all-transactions-status'].hidden, true);
  await nodes['#sync-all-transactions'].emit('click');
  await nodes['#deselect-all-accounts'].emit('click');
  assert.match(nodes['#all-transactions-list'].textContent, /No accounts are selected/);
  await nodes['#select-all-accounts'].emit('click');
  assert.match(nodes['#all-transactions-list'].innerHTML, /Saved purchase/, nodes['#all-transactions-list'].textContent);
  assert.deepEqual(calls, [['/api/accounts/transactions/all', 'GET']]);
});
test('batch import refresh expands an unfiltered amount range to include newly imported transactions', async () => {
  const { initializeTransactionsPage } = await import('../src/transactions-page.ts');
  const ids = [...renderTransactionsPage(user).matchAll(/id="([^" ]+)"/g)].map(match => '#' + match[1]);
  const nodes = dom(ids);
  nodes['#transaction-sort-order'].value = 'date-desc';
  nodes['#batch-import-dialog'].close = () => {};
  const importedTransaction = { ...transaction, id: 'tx-2', name: 'New purchase', amount: 30 };
  let saved = false;
  globalThis.fetch = async (url) => ({ ok: true, json: async () => {
    if (url.endsWith('/preview')) return { files: [{ fileName: 'new.csv', accountId: account.id, status: 'ready', reason: 'Selected', total: 1, duplicates: 0, importable: 1, errors: [], columns: [], mapping: null }] };
    if (url.endsWith('/import-batch')) { saved = true; return { imported: 1, skipped: 0 }; }
    return { accounts: [{ ...account, canImport: true }], transactions: saved ? [transaction, importedTransaction] : [transaction] };
  } });
  await initializeTransactionsPage();
  nodes['#batch-import-files'].files = [new File(['x'], 'new.csv')];
  await nodes['#batch-import-files'].emit('change');
  await nodes['#batch-import-form'].emit('submit');
  assert.equal(saved, true);
  assert.equal(nodes['#all-transactions-count'].textContent, 'Showing rows 1–2 of 2 · 2 transactions');
  assert.equal(nodes['#transactions-scroll-sentinel'].hidden, true);
  assert.match(nodes['#all-transactions-list'].innerHTML, /New purchase/);
});
test('frontend source has no retired integration assets or bank writes and preserves settings', async () => {
  const retired = new RegExp('tel' + 'ler', 'i');
  for (const file of await readdir(new URL('../src/', import.meta.url))) {
    assert.doesNotMatch(file, retired);
    const source = await readFile(new URL('../src/' + file, import.meta.url), 'utf8');
    assert.doesNotMatch(source, retired, file);
    assert.doesNotMatch(source, /\/api\/accounts\/[^"`]*(?:sync|enroll|connect-config)/, file);
  }
  const main = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(main, /Connect an institution to view/);
  for (const text of ['profile-form', 'password-form', 'authClient.updateUser', 'authClient.changePassword', 'authClient.signOut']) assert.ok(main.includes(text));
});
