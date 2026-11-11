import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { initializeTransactionsPage, renderTransactionsPage } from '../src/transactions-page.ts';

const user = { displayName: 'Tester', username: 'tester' };
test('mobile transfers inherit one shared outer rail with flush included transactions', async () => {
  const css = await readFile(new URL('../src/style.css', import.meta.url), 'utf8');
  const shared = css.slice(0, css.indexOf('@media'));
  const rule = selector => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return [...shared.matchAll(new RegExp(escaped + '\\s*\\{([^}]+)\\}', 'g'))]
      .map(match => match[1]).join('\n');
  };
  const container = rule('.transaction-transfer-pair');
  assert.match(container, /border:\s*0/);
  assert.match(rule('.transaction-transfer-pair::before'), /background:\s*#356747/);
  assert.match(container, /background:\s*#fff/);
  const children = rule('.transfer-pair-rows');
  assert.match(children, /border:\s*0/);
  assert.match(children, /margin:\s*0/);
  assert.match(children, /background:\s*#f5f5f4/);
  const summary = rule('.transaction-transfer-pair summary');
  assert.match(summary, /background:\s*#fff/);
  assert.match(summary, /border:\s*0/);
  assert.match(rule('.transfer-pair-details-label'), /border-bottom:\s*0/);
});

const accounts = [
  { id: 'checking', providerAccountId: 'checking', name: 'Checking', institutionName: 'Example', mask: '1234', type: 'depository' },
  { id: 'savings', providerAccountId: 'savings', name: 'Savings', institutionName: 'Example', mask: '5678', type: 'depository' },
];
const transactions = [
  { name: 'Coffee', account_id: 'checking', amount: 5, date: '2026-11-10', iso_currency_code: 'USD' },
  { name: 'Payroll', account_id: 'savings', amount: -100, date: '2026-11-09', iso_currency_code: 'USD' },
];

test('Transactions has icon-only funnel, sort, import actions and separate sheets', () => {
  const html = renderTransactionsPage(user);
  const heading = html.match(/<section class="page-heading transactions-page-heading">[\s\S]*?<\/section>/)?.[0];
  assert.ok(heading);
  assert.match(heading, /id="transaction-filters-trigger"[\s\S]*id="transaction-sort-trigger"[\s\S]*id="open-batch-import"/);
  assert.doesNotMatch(html, /YOUR MONEY, IN MOTION|transaction-activity-count|transaction-sort-summary/);
  assert.match(html, /id="transaction-search"[^>]*type="search"[^>]*aria-label="Search transactions"/);
  assert.match(html, /id="clear-transaction-search"[^>]*aria-label="Clear transaction search"/);
  assert.match(heading, /M12 3v12m-4-4 4 4 4-4M4 15v5h16v-5/);
  assert.doesNotMatch(heading, /ALL ACCOUNTS|Search saved activity across your accounts/);
  assert.doesNotMatch(heading, /class="subheading"|All your accounts/);
  const filter = html.match(/<dialog[^>]*id="transaction-filters-dialog"[\s\S]*?<\/dialog>/)?.[0];
  const sort = html.match(/<dialog[^>]*id="transaction-sort-dialog"[\s\S]*?<\/dialog>/)?.[0];
  assert.ok(filter);
  assert.ok(sort);
  assert.match(filter, /id="account-options"/);
  assert.match(filter, /id="minimum-transaction-amount"/);
  assert.doesNotMatch(filter, /transaction-sort-order|Sort by/);
  assert.match(sort, /id="transaction-sort-order"/);
  assert.doesNotMatch(sort, /account-options|minimum-transaction-amount/);
  assert.equal((html.match(/id="open-batch-import"/g) ?? []).length, 1);
});

test('filter and sort stay unavailable until the initial history has loaded', async t => {
  const html = renderTransactionsPage(user);
  assert.match(html, /id="transaction-filters-trigger"[^>]*disabled/);
  assert.match(html, /id="transaction-sort-trigger"[^>]*disabled/);
  const n = await setup(t);
  assert.equal(n['#transaction-filters-trigger'].disabled, false);
  assert.equal(n['#transaction-sort-trigger'].disabled, false);
});

class Element {
  value = ''; textContent = ''; hidden = false; disabled = false; checked = false; open = false;
  handlers = {}; dataset = {}; attributes = {}; style = { setProperty() {} }; checkboxes = []; html = '';
  classList = { toggle() {}, add() {}, remove() {} };
  addEventListener(name, handler) { (this.handlers[name] ??= []).push(handler); }
  async emit(name, extra = {}) { for (const handler of this.handlers[name] ?? []) await handler({ target: this, preventDefault() {}, ...extra }); }
  setAttribute(name, value) { this.attributes[name] = value; }
  focus() { this.focused = true; }
  showModal() { this.open = true; }
  close() { this.open = false; for (const handler of this.handlers.close ?? []) handler({ target: this }); }
  set innerHTML(value) { this.html = value; this.checkboxes = [...value.matchAll(/data-account-filter value="([^"]+)"/g)].map(m => Object.assign(new Element(), { value: m[1] })); }
  get innerHTML() { return this.html; }
  insertAdjacentHTML(_, html) { this.html += html; }
  querySelector() { return null; }
  querySelectorAll(selector) {
    if (selector === 'input[data-account-filter]') return this.checkboxes;
    if (selector === 'input[data-account-filter]:checked') return this.checkboxes.filter(i => i.checked);
    return [];
  }
}
async function setup(t) {
  const nodes = Object.fromEntries([...renderTransactionsPage(user).matchAll(/id="([^"]+)"/g)].map(m => ['#' + m[1], new Element()]));
  nodes['#transaction-sort-order'].value = 'date-desc';
  const previousDocument = globalThis.document;
  const previousObserver = globalThis.IntersectionObserver;
  globalThis.document = { querySelector: selector => nodes[selector] ?? null, addEventListener() {} };
  globalThis.IntersectionObserver = undefined;
  t.after(() => { globalThis.document = previousDocument; globalThis.IntersectionObserver = previousObserver; });
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => ({ accounts, transactions, configured: false }) }));
  await initializeTransactionsPage();
  return nodes;
}

test('filter sheet applies selections explicitly and cancel restores the applied selection', async t => {
  const n = await setup(t);
  const click = id => n['#' + id].emit('click');
  await click('transaction-filters-trigger');
  assert.equal(n['#transaction-filters-dialog'].open, true);
  await click('deselect-all-accounts');
  assert.match(n['#all-transactions-list'].innerHTML, /Coffee/);
  await click('cancel-transaction-filters');
  assert.equal(n['#account-options'].checkboxes.filter(i => i.checked).length, 2);
  await click('transaction-filters-trigger');
  await click('deselect-all-accounts');
  await click('apply-transaction-filters');
  assert.match(n['#all-transactions-list'].textContent, /No accounts are selected/);
  await click('transaction-filters-trigger');
  assert.equal(n['#account-options'].checkboxes.filter(i => i.checked).length, 0);
  await click('select-all-accounts');
  await click('apply-transaction-filters');
  assert.match(n['#all-transactions-list'].innerHTML, /Coffee/);
});

test('sort sheet applies independently, cancel preserves order, filter cancel restores amounts', async t => {
  const n = await setup(t);
  const click = id => n['#' + id].emit('click');
  const list = n['#all-transactions-list'];
  await click('transaction-sort-trigger');
  n['#transaction-sort-order'].value = 'amount-desc';
  await n['#transaction-sort-order'].emit('change');
  assert.ok(list.innerHTML.indexOf('Coffee') < list.innerHTML.indexOf('Payroll'));
  await click('cancel-transaction-sort');
  assert.equal(n['#transaction-sort-order'].value, 'date-desc');
  await click('transaction-sort-trigger');
  n['#transaction-sort-order'].value = 'amount-desc';
  await click('apply-transaction-sort');
  assert.ok(list.innerHTML.indexOf('Payroll') < list.innerHTML.indexOf('Coffee'));
  await click('transaction-filters-trigger');
  const originalMinimum = n['#minimum-transaction-amount'].value;
  n['#minimum-transaction-amount'].value = '0';
  await n['#minimum-transaction-amount'].emit('input');
  await click('cancel-transaction-filters');
  assert.equal(n['#minimum-transaction-amount'].value, originalMinimum);
  assert.equal(n['#transaction-sort-order'].value, 'amount-desc');
  assert.match(list.innerHTML, /Coffee/);
  assert.match(list.innerHTML, /Payroll/);
});
