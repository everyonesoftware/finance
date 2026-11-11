import assert from 'node:assert/strict';
import test from 'node:test';
import { initializeTransactionsPage, renderTransactionsPage } from '../src/transactions-page.ts';
import { renderDashboard } from '../src/dashboard.ts';

const account = { id: 'checking', providerAccountId: 'checking', name: 'Checking', institutionName: 'Example Bank', type: 'depository', mask: '1234' };
const transactions = (length) => Array.from({ length }, (_, index) => ({
  transaction_id: String(index), account_id: account.providerAccountId,
  name: `Purchase ${index}`, amount: index + 1, date: '2026-11-01', iso_currency_code: 'USD',
}));

class Element {
  isConnected = true;
  value = ''; hidden = false; disabled = false; textContent = ''; checked = false;
  handlers = {}; dataset = {}; style = { setProperty() {} }; checkboxes = []; html = '';
  addEventListener(name, handler) { (this.handlers[name] ??= []).push(handler); }
  async emit(name, extra = {}) { for (const handler of this.handlers[name] ?? []) await handler({ target: this, preventDefault() {}, ...extra }); }
  setAttribute() {} focus() {} scrollIntoView() {}
  set innerHTML(value) {
    this.html = value;
    this.checkboxes = [...value.matchAll(/data-account-filter value="([^"]+)"/g)].map((match) => Object.assign(new Element(), { value: match[1] }));
  }
  get innerHTML() { return this.html; }
  insertAdjacentHTML(position, html) {
    assert.equal(position, 'beforeend');
    this.html += html;
  }
  querySelector() { return null; }
  querySelectorAll(selector) {
    if (selector === 'input[data-account-filter]') return this.checkboxes;
    if (selector === 'input[data-account-filter]:checked') return this.checkboxes.filter(input => input.checked);
    return [];
  }
}

async function setup(t, records, accounts = [account], observerAvailable = true) {
  const html = renderTransactionsPage({ displayName: 'Tester', username: 'tester' });
  const nodes = Object.fromEntries([...html.matchAll(/id="([^"]+)"/g)].map(match => ['#' + match[1], new Element()]));
  nodes['#transaction-sort-order'].value = 'date-desc';
  const previous = globalThis.document;
  const previousObserver = globalThis.IntersectionObserver;
  globalThis.IntersectionObserver = observerAvailable ? class {
    targets = new Set();
    constructor(callback, options) { this.callback = callback; this.options = options; nodes.observer = this; }
    observe(target) { this.targets.add(target); }
    disconnect() { this.targets.clear(); }
  } : undefined;
  globalThis.document = { querySelector: selector => nodes[selector] ?? null, addEventListener() {} };
  t.after(() => { globalThis.document = previous; globalThis.IntersectionObserver = previousObserver; });
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => ({ transactions: records, accounts, configured: false }) }));
  await initializeTransactionsPage();
  return nodes;
}
const renderedRows = nodes => (nodes['#all-transactions-list'].innerHTML.match(/class="account-row transaction-row"/g) ?? []).length;
test('Transactions keeps dates in each row without day headings after sorting and appending', async t => {
  const nodes = await setup(t, transactions(101));
  const checkDates = () => {
    const html = nodes['#all-transactions-list'].innerHTML;
    assert.doesNotMatch(html, /transaction-date-heading/);
    assert.equal((html.match(/class="transaction-mobile-date">2026-11-01<\/span>/g) ?? []).length, renderedRows(nodes));
  };
  checkDates();
  reachEnd(nodes);
  checkDates();
  for (const sort of ['date-asc', 'amount-desc', 'date-desc']) {
    nodes['#transaction-sort-order'].value = sort;
    await nodes['#transaction-sort-order'].emit('change');
    checkDates();
  }
});

function reachEnd(nodes, isIntersecting = true) {
  assert.ok(nodes.observer, 'Infinite scroll must observe the end of the list');
  nodes.observer.callback([{ target: nodes['#transactions-scroll-sentinel'], isIntersecting }]);
}

test('transaction search reaches unseen history, composes with filters, and clearing resets pagination', async t => {
  const nodes = await setup(t, transactions(151));
  const input = nodes['#transaction-search'];
  assert.ok(input);
  input.value = 'purchase 150';
  await input.emit('input');
  assert.equal(renderedRows(nodes), 1);
  assert.match(nodes['#all-transactions-list'].innerHTML, />Purchase 150<\/strong>/);
  assert.match(nodes['#all-transactions-count'].textContent, /1–1 of 1/);
  assert.equal(nodes['#clear-transaction-search'].hidden, false);
  await nodes['#deselect-all-accounts'].emit('click');
  assert.match(nodes['#all-transactions-list'].textContent, /No accounts are selected/);
  await nodes['#select-all-accounts'].emit('click');
  assert.equal(renderedRows(nodes), 1);
  nodes['#minimum-transaction-amount'].value = '-100';
  await nodes['#minimum-transaction-amount'].emit('input');
  assert.match(nodes['#all-transactions-list'].textContent, /No transactions match/);
  await nodes['#reset-amount-filter'].emit('click');
  assert.equal(renderedRows(nodes), 1);
  await nodes['#clear-transaction-search'].emit('click');
  assert.equal(input.value, '');
  assert.equal(nodes['#clear-transaction-search'].hidden, true);
  assert.equal(renderedRows(nodes), 50);
  assert.equal(nodes['#transactions-scroll-sentinel'].hidden, false);
  reachEnd(nodes);
  assert.equal(renderedRows(nodes), 100);
  input.value = 'not present';
  await input.emit('input');
  assert.match(nodes['#all-transactions-list'].textContent, /No transactions match/);
  await input.emit('keydown', { key: 'Escape' });
  assert.equal(input.value, '');
  assert.equal(renderedRows(nodes), 50);
  input.value = 'Purchase';
  await input.emit('input');
  nodes['#transaction-sort-order'].value = 'amount-asc';
  await nodes['#transaction-sort-order'].emit('change');
  assert.match(nodes['#all-transactions-list'].innerHTML, />Purchase 150<\/strong>/);
});

test('Overview recent transactions panel links to all transactions from its heading', () => {
  const html = renderDashboard({ displayName: 'Tester', username: 'tester' });
  const panel = html.match(/<article class="panel transactions-panel"[\s\S]*?<\/article>/)?.[0];
  assert.match(panel, /<div class="panel-heading">[\s\S]*?<a class="text-button" href="\/transactions">See all<\/a>[\s\S]*?<div id="transaction-list"/);
});

test('infinite scroll appends 50 rows near the end and keeps previously loaded transactions', async t => {
  const nodes = await setup(t, transactions(101));
  assert.equal(renderedRows(nodes), 50);
  assert.equal(nodes['#transactions-view-more'], undefined);
  assert.equal(nodes['#transactions-scroll-sentinel'].hidden, false);
  assert.match(nodes['#all-transactions-count'].textContent, /1–50 of 101/);
  reachEnd(nodes, false);
  assert.equal(renderedRows(nodes), 50);
  reachEnd(nodes);
  assert.equal(renderedRows(nodes), 100);
  assert.match(nodes['#all-transactions-list'].innerHTML, />Purchase 50<\/strong>/);
  assert.match(nodes['#all-transactions-list'].innerHTML, />Purchase 0<\/strong>/);
  reachEnd(nodes);
  assert.equal(renderedRows(nodes), 101);
  assert.equal(nodes['#transactions-scroll-sentinel'].hidden, true);
  assert.equal(nodes.observer.targets.size, 0);
  assert.match(nodes['#all-transactions-count'].textContent, /1–101 of 101/);
  reachEnd(nodes);
  assert.equal(renderedRows(nodes), 101);
  assert.equal(globalThis.fetch.mock.callCount(), 1, 'Scrolling must use the already loaded full history');
});

test('filters and sorting operate on unseen history and reset the visible batch', async t => {
  const nodes = await setup(t, transactions(151));
  reachEnd(nodes);
  assert.equal(renderedRows(nodes), 100);
  nodes['#transaction-sort-order'].value = 'amount-asc';
  await nodes['#transaction-sort-order'].emit('change');
  assert.equal(renderedRows(nodes), 50);
  assert.match(nodes['#all-transactions-list'].innerHTML, />Purchase 150<\/strong>/);
  nodes['#maximum-transaction-amount'].value = '-149';
  await nodes['#maximum-transaction-amount'].emit('input');
  assert.equal(renderedRows(nodes), 3);
  assert.match(nodes['#all-transactions-list'].innerHTML, />Purchase 150<\/strong>/);
  assert.equal(nodes['#transactions-scroll-sentinel'].hidden, true);
  await nodes['#deselect-all-accounts'].emit('click');
  assert.match(nodes['#all-transactions-list'].textContent, /No accounts are selected/);
  assert.equal(nodes['#transactions-scroll-sentinel'].hidden, true);
  await nodes['#select-all-accounts'].emit('click');
  assert.equal(renderedRows(nodes), 3);
  await nodes['#reset-amount-filter'].emit('click');
  assert.equal(renderedRows(nodes), 50);
  assert.equal(nodes['#transactions-scroll-sentinel'].hidden, false);
  assert.equal(nodes.observer.targets.size, 1, 'Resetting filters must re-arm infinite scrolling');
});

test('empty, partial and exact batches stop observing when there is nothing left', async t => {
  for (const length of [0, 1, 50, 100]) {
    await t.test(String(length), async t => {
      const nodes = await setup(t, transactions(length));
      assert.equal(renderedRows(nodes), Math.min(length, 50));
      assert.equal(nodes['#transactions-scroll-sentinel'].hidden, length <= 50);
      if (length === 100) {
        reachEnd(nodes);
        assert.equal(renderedRows(nodes), 100);
        assert.equal(nodes['#transactions-scroll-sentinel'].hidden, true);
      }
    });
  }
});

test('account filters find transactions beyond the initial batch', async t => {
  const savings = { ...account, id: 'savings', providerAccountId: 'savings', name: 'Savings' };
  const records = transactions(151).map((record, index) => index < 100 ? record : { ...record, account_id: savings.id });
  const nodes = await setup(t, records, [account, savings]);
  const options = nodes['#account-options'];
  options.checkboxes.find(input => input.value === account.id).checked = false;
  await options.emit('change');
  assert.equal(renderedRows(nodes), 50);
  assert.match(nodes['#all-transactions-list'].innerHTML, />Purchase 100<\/strong>/);
  assert.doesNotMatch(nodes['#all-transactions-list'].innerHTML, />Purchase 0<\/strong>/);
  assert.match(nodes['#all-transactions-count'].textContent, /1–50 of 51/);
  reachEnd(nodes);
  assert.equal(renderedRows(nodes), 51);
  assert.equal(nodes['#transactions-scroll-sentinel'].hidden, true);
});

test('infinite scroll keeps both sides of a transfer together across batch boundaries', async t => {
  const savings = { ...account, id: 'savings', providerAccountId: 'savings', name: 'Savings', mask: '5678' };
  const records = transactions(49);
  records.push(
    { account_id: 'checking', name: 'Transfer to Savings 5678', amount: 500, date: '2026-11-01', iso_currency_code: 'USD' },
    { account_id: 'savings', name: 'Transfer from Checking 1234', amount: -500, date: '2026-11-01', iso_currency_code: 'USD' },
    ...transactions(2).map(tx => ({ ...tx, name: 'Later ' + tx.name })),
  );
  const nodes = await setup(t, records, [account, savings]);
  assert.match(nodes['#all-transactions-list'].innerHTML, /<strong>Checking → Savings<\/strong>/);
  assert.match(nodes['#all-transactions-list'].innerHTML, /<span class="transaction-group-type">Transfer<\/span>/);
  assert.equal((nodes['#all-transactions-list'].innerHTML.match(/class="transaction-transfer-pair"/g) ?? []).length, 1);
  assert.equal(renderedRows(nodes), 51); // 49 ordinary rows and two expanded originals, one grouped row.
  reachEnd(nodes);
  assert.equal(renderedRows(nodes), 53);
  assert.equal((nodes['#all-transactions-list'].innerHTML.match(/class="transaction-transfer-pair"/g) ?? []).length, 1);
  assert.equal(nodes['#transactions-scroll-sentinel'].hidden, true);
});

test('payment groups span history batches and remain visible when filtering by the credit card', async t => {
  const card = { ...account, id: 'citi-card', providerAccountId: 'citi-card', institutionName: 'Citi', name: 'Costco Card', type: 'credit', subtype: 'credit card' };
  const records = transactions(49).map(record => ({ ...record, date: '2026-11-10' }));
  records.push(
    { account_id: 'checking', name: 'CITI CARD ONLINE PAYMENT', amount: 646.67, date: '2026-11-10', iso_currency_code: 'USD' },
    ...transactions(10),
    { account_id: 'citi-card', name: 'ONLINE PAYMENT, THANK YOU', amount: -646.67, date: '2026-11-09', iso_currency_code: 'USD' },
  );
  const nodes = await setup(t, records, [account, card]);
  assert.equal((nodes['#all-transactions-list'].innerHTML.match(/class="transaction-transfer-pair"/g) ?? []).length, 1);
  assert.match(nodes['#all-transactions-list'].innerHTML, /<strong>Checking → Costco Card<\/strong>/);
  assert.match(nodes['#all-transactions-list'].innerHTML, /<span class="transaction-group-type">Credit Card Payment<\/span>/);
  assert.match(nodes['#all-transactions-count'].textContent, /1–50 of 60/);
  reachEnd(nodes);
  assert.equal((nodes['#all-transactions-list'].innerHTML.match(/class="transaction-transfer-pair"/g) ?? []).length, 1);
  const options = nodes['#account-options'];
  options.checkboxes.find(input => input.value === account.id).checked = false;
  await options.emit('change');
  assert.match(nodes['#all-transactions-count'].textContent, /1–1 of 1/);
  assert.match(nodes['#all-transactions-list'].innerHTML, /<strong>Checking → Costco Card<\/strong>/);
  assert.match(nodes['#all-transactions-list'].innerHTML, /<span class="transaction-group-type">Credit Card Payment<\/span>/);
});

test('TreasuryDirect batches stay complete across pagination, total search, and amount filters', async t => {
  const payment = (amount, index) => ({
    transaction_id: `treasury-${index}`, account_id: account.providerAccountId,
    name: `APA TREAS 310 MISC PAY~ Future Amount: ${amount.toFixed(2)} ~ Tran: DDIR`,
    date: '2026-11-02', amount: -amount, iso_currency_code: 'USD', pending: false,
  });
  const payments = [45.38, 37.13, 41.25, 11.56, 11.56, 12.19, 12.19, 22.75, 22.75].map(payment);
  const input = [
    ...transactions(49).map(record => ({ ...record, date: '2026-11-03' })),
    payments[0], ...transactions(10), ...payments.slice(1),
  ];
  const nodes = await setup(t, input);
  const list = nodes['#all-transactions-list'];
  assert.match(nodes['#all-transactions-count'].textContent, /1–50 of 60/);
  assert.match(list.innerHTML, /Bond payments · 9 transactions/);
  assert.match(list.innerHTML, /class="transfer-pair-amount">\$216\.76/);
  assert.equal(renderedRows(nodes), 58);
  reachEnd(nodes);
  assert.equal(renderedRows(nodes), 68);
  assert.equal((list.innerHTML.match(/class="transaction-transfer-pair"/g) ?? []).length, 1);
  const inputSearch = nodes['#transaction-search'];
  for (const query of ['$216.76', 'Future Amount: 37.13']) {
    inputSearch.value = query;
    await inputSearch.emit('input');
    assert.equal(renderedRows(nodes), 9);
    assert.match(nodes['#all-transactions-count'].textContent, /1–1 of 1/);
  }
  await nodes['#clear-transaction-search'].emit('click');
  nodes['#minimum-transaction-amount'].value = '216';
  await nodes['#minimum-transaction-amount'].emit('input');
  assert.equal(renderedRows(nodes), 9);
  await nodes['#deselect-all-accounts'].emit('click');
  assert.match(list.textContent, /No accounts are selected/);
});

test('detached transaction lists disconnect their observer without appending rows', async t => {
  const nodes = await setup(t, transactions(101));
  nodes['#transactions-scroll-sentinel'].isConnected = false;
  reachEnd(nodes);
  assert.equal(renderedRows(nodes), 50);
  assert.equal(nodes.observer.targets.size, 0);
});

test('browsers without IntersectionObserver can still access the complete matching history', async t => {
  const nodes = await setup(t, transactions(101), [account], false);
  assert.equal(renderedRows(nodes), 101);
  assert.equal(nodes['#transactions-scroll-sentinel'].hidden, true);
  nodes['#maximum-transaction-amount'].value = '-99';
  await nodes['#maximum-transaction-amount'].emit('input');
  assert.equal(renderedRows(nodes), 3);
});
