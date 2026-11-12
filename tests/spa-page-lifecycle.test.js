import assert from 'node:assert/strict';
import test from 'node:test';
import { initializeTransactionsPage, initializeResponsiveTransactions, renderTransactionsPage } from '../src/transactions-page.ts';
import * as bank from '../src/bank_accounts.ts';

const user = { displayName: 'Tester', username: 'tester' };
test('responsive listener is released on abort even when the shared shell stays connected', t => {
  setup(t); const controller = new AbortController(); const viewport = new Element(); viewport.matches = false;
  let appends = 0; const child = new Element(); child.append = () => { appends++; };
  const root = new Element(); root.querySelector = () => child;
  initializeResponsiveTransactions(root, viewport, controller.signal);
  assert.equal(viewport.handlers.change.size, 1);
  controller.abort();
  assert.equal(viewport.handlers.change.size, 0);
  const previous = appends;
  void viewport.emit('change');
  assert.equal(appends, previous);
});
const account = { id: 'A', itemId: 'item-A', providerAccountId: 'A', institutionName: 'Bank', name: 'Account A', officialName: null, type: 'depository', subtype: 'checking', mask: '1234', currentBalance: 12, availableBalance: 12, currencyCode: 'USD', updatedAt: '2026-01-01', canImport: true };
const deferred = () => { let resolve, reject; const promise = new Promise((r, j) => { resolve = r; reject = j; }); return { promise, resolve, reject }; };
const response = payload => ({ ok: true, json: async () => payload });
for (const [name, html, selector, initialize, payload] of [
  ['Overview', '<div id="overview-bank-accounts"></div><div id="overview-total-balance"></div>', '#overview-bank-accounts', signal => bank.initializeOverviewBankAccounts(signal), { configured: false, accounts: [account] }],
  ['Accounts', bank.renderBankAccountsPage(user), '#connected-accounts', signal => bank.initializeBankAccountsPage(signal), { configured: false, accounts: [account] }],
  ['account detail', bank.renderBankAccountDetailPage(user), '#account-detail-content', signal => bank.initializeAccountDetailPage('A', signal), { account, accounts: [account], transactions: [] }],
  ['Real Estate', bank.renderConnectionsPage(user), '#real-estate-properties', signal => bank.initializeConnectionsPage(signal), { properties: [] }],
]) {
  test(`${name} ignores its delayed read after abort`, async t => {
    const { nodes } = setup(t, html); const pending = deferred(); const controller = new AbortController();
    t.mock.method(globalThis, 'fetch', () => pending.promise);
    const loading = initialize(controller.signal); controller.abort(); pending.resolve(response(payload));
    await loading; await new Promise(resolve => setImmediate(resolve));
    assert.equal(nodes[selector].innerHTML, '');
  });
}

test('delayed account A cannot wire its import handler into account B even without a signal', async t => {
  const { nodes, doc } = setup(t, bank.renderBankAccountDetailPage(user)); const pending = deferred();
  t.mock.method(globalThis, 'fetch', () => pending.promise);
  const loading = bank.initializeAccountDetailPage('A');
  nodes['#account-detail-content'].isConnected = false;
  const importButtonB = new Element(); doc.querySelector = selector => selector === '#import-transactions' ? importButtonB : new Element();
  pending.resolve(response({ account, accounts: [account], transactions: [] })); await loading;
  assert.equal(importButtonB.handlers.click?.size ?? 0, 0);
  assert.equal(nodes['#account-detail-content'].innerHTML, '');
});

for (const leave of ['stay', 'abort', 'detach']) {
  test(`manual account completion uses SPA navigation only for its original live page (${leave})`, async t => {
    const { nodes, doc } = setup(t, bank.renderBankAccountsPage(user)); const controller = new AbortController(); const pending = deferred();
    const navigations = [], documentLoads = [], writes = [];
    doc.body = { append() {} }; doc.createElement = () => { const link = { remove() {}, click() { navigations.push(link.href); } }; return link; };
    globalThis.window.location = { assign: href => documentLoads.push(href) };
    globalThis.FormData = class { get(key) { return ({ name: 'New account', institutionName: 'Bank', accountKind: 'depository:checking', currencyCode: 'USD' })[key] ?? ''; } };
    t.mock.method(globalThis, 'fetch', (url, options = {}) => {
      if (options.method === 'POST') { writes.push(options); return pending.promise; }
      return Promise.resolve(response({ configured: false, accounts: [] }));
    });
    bank.initializeBankAccountsPage(controller.signal);
    const saving = nodes['#manual-account-form'].emit('submit');
    assert.equal(writes.length, 1);
    if (leave === 'abort') controller.abort();
    if (leave === 'detach') nodes['#connected-accounts'].isConnected = false;
    pending.resolve(response({ account: { ...account, id: 'new/account' } })); await saving;
    assert.deepEqual(documentLoads, []);
    assert.deepEqual(navigations, leave === 'stay' ? ['/accounts/new%2Faccount'] : []);
    assert.equal(writes[0].signal, undefined, 'financial writes are allowed to finish, never aborted');
  });
}
class Element {
  handlers = {}; value = ''; textContent = ''; html = ''; hidden = false; disabled = true; isConnected = true; dataset = {}; checkboxes = []; open = false;
  style = { setProperty() {} }; classList = { toggle() {} };
  addEventListener(name, fn) { (this.handlers[name] ??= new Set()).add(fn); }
  removeEventListener(name, fn) { this.handlers[name]?.delete(fn); }
  async emit(name, extra = {}) { for (const fn of [...this.handlers[name] ?? []]) await fn({ target: this, currentTarget: this, preventDefault() {}, ...extra }); }
  setAttribute() {} focus() {} append() {} reset() { this.resets = (this.resets ?? 0) + 1; } replaceChildren() { this.html = ''; } close() { this.open = false; } showModal() { this.open = true; }
  set innerHTML(value) { this.html = value; this.checkboxes = [...value.matchAll(/data-account-filter value="([^"]+)"/g)].map(m => Object.assign(new Element(), { value: m[1], checked: false })); }
  get innerHTML() { return this.html; }
  insertAdjacentHTML(_, value) { this.html += value; }
  querySelector() { return null; }
  querySelectorAll(selector) { return selector.startsWith('input[data-account-filter]') ? this.checkboxes.filter(c => !selector.includes(':checked') || c.checked) : []; }
}
function setup(t, html = renderTransactionsPage(user)) {
  const nodes = Object.fromEntries([...html.matchAll(/id="([^"]+)"/g)].map(m => ['#' + m[1], new Element()]));
  const doc = new Element(); doc.querySelector = selector => nodes[selector] ?? null;
  const saved = Object.fromEntries(['document', 'window', 'IntersectionObserver', 'FormData'].map(k => [k, globalThis[k]]));
  globalThis.document = doc; globalThis.window = {}; globalThis.IntersectionObserver = undefined;
  t.after(() => Object.assign(globalThis, saved));
  return { nodes, doc };
}

test('Real Estate cancels pending suggestion timers and ignores in-flight suggestions on abort', async t => {
  const { nodes } = setup(t, bank.renderConnectionsPage(user)); const controller = new AbortController(); const pending = deferred();
  let callback, cleared = [];
  globalThis.window = { setTimeout(fn) { callback = fn; return 42; }, clearTimeout(id) { cleared.push(id); } };
  t.mock.method(globalThis, 'fetch', url => url === '/api/real-estate' ? Promise.resolve(response({ properties: [] })) : pending.promise);
  await bank.initializeConnectionsPage(controller.signal);
  nodes['#property-address'].value = '123 Main'; await nodes['#property-address'].emit('input');
  const searching = callback(); controller.abort();
  assert.ok(cleared.includes(42));
  pending.resolve(response([{ display_name: 'Late address', lat: '1', lon: '2' }])); await searching;
  assert.equal(nodes['#address-suggestions'].innerHTML, '');
});

for (const stage of ['geocode', 'write']) {
  test(`Real Estate ignores stale ${stage} completion without aborting a started write`, async t => {
    const { nodes } = setup(t, bank.renderConnectionsPage(user)); const controller = new AbortController(); const pending = deferred(); const calls = [];
    globalThis.FormData = class { get(key) { return key === 'address' ? '123 Main' : 'https://example.test/property'; } };
    t.mock.method(globalThis, 'fetch', (url, options = {}) => {
      calls.push([url, options]);
      if (url === '/api/real-estate' && options.method !== 'POST') return Promise.resolve(response({ properties: [] }));
      if (stage === 'geocode' || options.method === 'POST') return pending.promise;
      return Promise.resolve(response([{ display_name: '123 Main', lat: '1', lon: '2' }]));
    });
    await bank.initializeConnectionsPage(controller.signal);
    const saving = nodes['#add-property-form'].emit('submit');
    await new Promise(resolve => setImmediate(resolve));
    controller.abort(); pending.resolve(response(stage === 'geocode' ? [{ display_name: '123 Main', lat: '1', lon: '2' }] : { property: {} })); await saving;
    assert.equal(calls.filter(([, options]) => options.method === 'POST').length, stage === 'write' ? 1 : 0);
    assert.ok(calls.every(([, options]) => options.signal === undefined));
    assert.equal(nodes['#add-property-form'].resets ?? 0, 0);
    assert.equal(nodes['#property-form-message'].textContent, '');
    assert.equal(calls.filter(([url, options]) => url === '/api/real-estate' && options.method !== 'POST').length, 1);
  });
}

test('Transactions abort removes document handlers and observer and blocks late initial rendering', async t => {
  const { nodes, doc } = setup(t); const pending = deferred(); const controller = new AbortController();
  let observer;
  globalThis.IntersectionObserver = class { constructor(callback) { this.callback = callback; observer = this; } disconnect() { this.disconnected = true; } observe() { this.observations = (this.observations ?? 0) + 1; } };
  t.mock.method(globalThis, 'fetch', () => pending.promise);
  const loading = initializeTransactionsPage(controller.signal);
  assert.equal(doc.handlers.click.size, 1);
  controller.abort();
  assert.equal(doc.handlers.click.size, 0);
  assert.equal(doc.handlers.keydown.size, 0);
  assert.equal(observer.disconnected, true);
  pending.resolve(response({ accounts: [account], transactions: [{ account_id: 'A', name: 'Late purchase', amount: 1, date: '2026-01-01' }] }));
  await loading;
  assert.equal(nodes['#all-transactions-list'].innerHTML, '');
  assert.equal(nodes['#transaction-filters-trigger'].disabled, true);
  observer.callback([{ target: nodes['#transactions-scroll-sentinel'], isIntersecting: true }]);
  assert.equal(observer.observations ?? 0, 0);
});

for (const outcome of ['success', 'failure']) {
  test(`Transactions ignores a delayed post-import refresh ${outcome} without rearming or reopening the old dialog`, async t => {
    const { nodes } = setup(t); const controller = new AbortController(); const pending = deferred();
    const records = Array.from({ length: 60 }, (_, i) => ({ id: `tx-${i}`, account_id: 'A', name: `Purchase ${i}`, amount: 1, date: '2026-01-01' }));
    let reads = 0, observer;
    globalThis.IntersectionObserver = class { constructor(callback) { this.callback = callback; observer = this; } disconnect() {} observe() { this.observations = (this.observations ?? 0) + 1; } };
    t.mock.method(globalThis, 'fetch', url => {
      if (url.endsWith('/preview')) return Promise.resolve(response({ files: [{ fileName: 'new.csv', accountId: 'A', status: 'ready', reason: 'Selected', total: 1, duplicates: 0, importable: 1, errors: [], columns: [], mapping: null }] }));
      if (url.endsWith('/import-batch')) return Promise.resolve(response({ imported: 1, skipped: 0 }));
      if (++reads === 1) return Promise.resolve(response({ accounts: [account], transactions: records }));
      return pending.promise;
    });
    await initializeTransactionsPage(controller.signal);
    nodes['#batch-import-files'].files = [new File(['x'], 'new.csv')];
    await nodes['#batch-import-files'].emit('change');
    const html = nodes['#all-transactions-list'].innerHTML, count = nodes['#all-transactions-count'].textContent, observations = observer.observations;
    const saving = nodes['#batch-import-form'].emit('submit'); await new Promise(resolve => setImmediate(resolve));
    assert.equal(reads, 2); controller.abort();
    if (outcome === 'failure') pending.reject(new Error('Late network failure'));
    else pending.resolve(response({ accounts: [account], transactions: [...records, { ...records[0], name: 'New purchase' }] }));
    await saving;
    assert.equal(nodes['#all-transactions-list'].innerHTML, html);
    assert.equal(nodes['#all-transactions-count'].textContent, count);
    assert.equal(observer.observations, observations);
    assert.equal(nodes['#batch-import-dialog'].open, false);
  });
}
