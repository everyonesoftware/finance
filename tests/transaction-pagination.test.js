import assert from 'node:assert/strict';
import test from 'node:test';
import { initializeTransactionsPage, renderTransactionsPage } from '../src/transactions-page.ts';

const account = { id: 'checking', providerAccountId: 'checking', name: 'Checking', institutionName: 'Example Bank', type: 'depository', mask: '1234' };
const transactions = (length) => Array.from({ length }, (_, index) => ({
  transaction_id: String(index), account_id: account.providerAccountId,
  name: `Purchase ${index}`, amount: index + 1, date: '2026-11-01', iso_currency_code: 'USD',
}));

class Element {
  value = ''; hidden = false; disabled = false; textContent = ''; checked = false;
  handlers = {}; dataset = {}; style = { setProperty() {} }; checkboxes = []; html = '';
  addEventListener(name, handler) { (this.handlers[name] ??= []).push(handler); }
  async emit(name) { for (const handler of this.handlers[name] ?? []) await handler({ target: this, preventDefault() {} }); }
  setAttribute() {} focus() {} scrollIntoView() {}
  set innerHTML(value) {
    this.html = value;
    this.checkboxes = [...value.matchAll(/data-account-filter value="([^"]+)"/g)].map((match) => Object.assign(new Element(), { value: match[1] }));
  }
  get innerHTML() { return this.html; }
  querySelector() { return null; }
  querySelectorAll(selector) {
    if (selector === 'input[data-account-filter]') return this.checkboxes;
    if (selector === 'input[data-account-filter]:checked') return this.checkboxes.filter(input => input.checked);
    return [];
  }
}

async function setup(t, records, accounts = [account]) {
  const html = renderTransactionsPage({ displayName: 'Tester', username: 'tester' });
  const nodes = Object.fromEntries([...html.matchAll(/id="([^"]+)"/g)].map(match => ['#' + match[1], new Element()]));
  nodes['#transaction-sort-order'].value = 'date-desc';
  const previous = globalThis.document;
  globalThis.document = { querySelector: selector => nodes[selector] ?? null, addEventListener() {} };
  t.after(() => { globalThis.document = previous; });
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => ({ transactions: records, accounts, configured: false }) }));
  await initializeTransactionsPage();
  return nodes;
}
const renderedRows = nodes => (nodes['#all-transactions-list'].innerHTML.match(/class="account-row transaction-row"/g) ?? []).length;

test('Transactions renders at most 50 rows and navigates the complete filtered history', async t => {
  const nodes = await setup(t, transactions(101));
  assert.equal(renderedRows(nodes), 50);
  assert.equal(nodes['#transactions-previous-page'].disabled, true);
  assert.equal(nodes['#transactions-next-page'].disabled, false);
  assert.equal(nodes['#transactions-page-status'].textContent, 'Page 1 of 3');
  assert.match(nodes['#all-transactions-count'].textContent, /1–50 of 101/);
  await nodes['#transactions-next-page'].emit('click');
  assert.equal(renderedRows(nodes), 50);
  assert.match(nodes['#all-transactions-list'].innerHTML, />Purchase 50<\/strong>/);
  assert.doesNotMatch(nodes['#all-transactions-list'].innerHTML, />Purchase 0<\/strong>/);
  await nodes['#transactions-next-page'].emit('click');
  assert.equal(renderedRows(nodes), 1);
  assert.equal(nodes['#transactions-next-page'].disabled, true);
  assert.match(nodes['#all-transactions-count'].textContent, /101–101 of 101/);
  await nodes['#transactions-previous-page'].emit('click');
  assert.equal(nodes['#transactions-page-status'].textContent, 'Page 2 of 3');
  nodes['#transaction-sort-order'].value = 'amount-asc';
  await nodes['#transaction-sort-order'].emit('change');
  assert.equal(nodes['#transactions-page-status'].textContent, 'Page 1 of 3');
  assert.match(nodes['#all-transactions-list'].innerHTML, />Purchase 100<\/strong>/);
  await nodes['#transactions-next-page'].emit('click');
  nodes['#minimum-transaction-amount'].value = '-3';
  await nodes['#minimum-transaction-amount'].emit('input');
  assert.equal(renderedRows(nodes), 3);
  assert.equal(nodes['#transactions-page-status'].textContent, 'Page 1 of 1');
  assert.equal(nodes['#transactions-pagination'].hidden, true);
  await nodes['#deselect-all-accounts'].emit('click');
  assert.match(nodes['#all-transactions-list'].textContent, /No accounts are selected/);
  assert.equal(nodes['#transactions-pagination'].hidden, true);
  assert.equal(nodes['#transactions-next-page'].disabled, true);
  await nodes['#select-all-accounts'].emit('click');
  assert.equal(renderedRows(nodes), 3);
});

test('zero, partial and exact pages disable unavailable navigation', async t => {
  for (const length of [0, 1, 50, 100]) {
    await t.test(String(length), async t => {
      const nodes = await setup(t, transactions(length));
      assert.equal(renderedRows(nodes), Math.min(length, 50));
      assert.equal(nodes['#transactions-pagination'].hidden, length <= 50);
      assert.equal(nodes['#transactions-previous-page'].disabled, true);
      assert.equal(nodes['#transactions-next-page'].disabled, length <= 50);
      if (length === 100) {
        await nodes['#transactions-next-page'].emit('click');
        assert.equal(renderedRows(nodes), 50);
        assert.equal(nodes['#transactions-next-page'].disabled, true);
      }
    });
  }
});

test('pagination keeps both sides of a transfer together at a page boundary', async t => {
  const savings = { ...account, id: 'savings', providerAccountId: 'savings', name: 'Savings', mask: '5678' };
  const records = transactions(49);
  records.push(
    { account_id: 'checking', name: 'Transfer to Savings 5678', amount: 500, date: '2026-11-01', iso_currency_code: 'USD' },
    { account_id: 'savings', name: 'Transfer from Checking 1234', amount: -500, date: '2026-11-01', iso_currency_code: 'USD' },
    ...transactions(2).map(tx => ({ ...tx, name: 'Later ' + tx.name })),
  );
  const nodes = await setup(t, records, [account, savings]);
  assert.match(nodes['#all-transactions-list'].innerHTML, /Transfer: Checking → Savings/);
  assert.equal((nodes['#all-transactions-list'].innerHTML.match(/class="transaction-transfer-pair"/g) ?? []).length, 1);
  assert.equal(renderedRows(nodes), 51); // 49 ordinary rows and two expanded originals, one grouped row.
  await nodes['#transactions-next-page'].emit('click');
  assert.equal(renderedRows(nodes), 2);
  assert.doesNotMatch(nodes['#all-transactions-list'].innerHTML, /transaction-transfer-pair/);
});
