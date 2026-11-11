import assert from 'node:assert/strict';
import test from 'node:test';
import { renderBankAccountsPage, renderAccountDetail } from '../src/bank_accounts.ts';
import * as workflow from '../src/account-import.ts';

const user = { displayName: 'Import Tester', username: 'import-test' };
const account = { id: 'manual-1', itemId: 'manual-item', providerAccountId: 'manual-provider', name: 'Checking', institutionName: 'Example Bank', type: 'depository', subtype: 'checking', mask: '1234', currencyCode: 'USD', currentBalance: 100, availableBalance: null, officialName: null, updatedAt: '2026-11-01T00:00:00Z', source: 'manual', canImport: true };

test('accounts page offers manual creation with fields needed for transfer matching', () => {
  const html = renderBankAccountsPage(user);
  assert.match(html, /id="add-account"/);
  assert.match(html, /id="manual-account-dialog"/);
  for (const name of ['name', 'institutionName', 'accountKind', 'currencyCode', 'mask', 'currentBalance']) assert.ok(html.includes(`name="${name}"`), name);
  assert.match(html, /Last four digits/);
  assert.match(html, /balance.*not.*changed.*imports/i);
});

test('manual account details offer an import wizard but saved accounts stay read-only', () => {
  const html = renderAccountDetail(account, [], [account]);
  assert.match(html, /id="import-transactions"/);
  assert.match(html, /id="account-import-dialog"/);
  assert.match(html, /accept=".csv,.ofx,.qfx"/);
  assert.match(html, /id="import-back"/);
  assert.match(html, /id="import-next"/);
  assert.match(html, /id="import-date-format"/);
  assert.match(html, /id="import-amount-convention"/);
  assert.doesNotMatch(renderAccountDetail({ ...account, source: 'saved', canImport: false }, [], [account]), /id="import-transactions"/);
});

class Element {
  value = ''; hidden = false; disabled = false; textContent = ''; innerHTML = ''; files = []; open = false;
  handlers = {}; classList = { toggle() {} }; elements = {};
  addEventListener(name, handler) { (this.handlers[name] ??= []).push(handler); }
  async emit(name) { for (const handler of this.handlers[name] ?? []) await handler({ preventDefault() {}, currentTarget: this, target: this }); }
  querySelector(selector) { return this.elements[selector] ?? null; }
  showModal() { this.open = true; }
  close() { this.open = false; }
  reset() {} focus() {}
}
function setup(t, ids) {
  const nodes = Object.fromEntries(ids.map(id => [id, new Element()]));
  t.mock.method(globalThis, 'fetch', async () => { throw Error('Unexpected request'); });
  const previousDocument = globalThis.document;
  globalThis.document = { querySelector: id => nodes[id] ?? null };
  t.after(() => { globalThis.document = previousDocument; });
  return nodes;
}

test('creation posts manual account values and only advances after a successful save', async t => {
  assert.equal(typeof workflow.initializeManualAccountCreation, 'function');
  const nodes = setup(t, ['#manual-account-dialog', '#manual-account-form', '#add-account', '#cancel-manual-account', '#manual-account-error']);
  const submit = new Element();
  nodes['#manual-account-form'].elements['button[type="submit"]'] = submit;
  const OriginalFormData = globalThis.FormData;
  globalThis.FormData = class { get(name) { return ({ name: 'Checking', institutionName: 'Example Bank', accountKind: 'depository:checking', currencyCode: 'usd', mask: '1234', currentBalance: '100.00' })[name]; } };
  t.after(() => { globalThis.FormData = OriginalFormData; });
  const saved = [], calls = [];
  workflow.initializeManualAccountCreation(async value => saved.push(value));
  await nodes['#add-account'].emit('click');
  assert.equal(nodes['#manual-account-dialog'].open, true);
  globalThis.fetch = async (url, options) => { calls.push([url, options]); return { ok: false, json: async () => ({ error: 'Save failed.' }) }; };
  await nodes['#manual-account-form'].emit('submit');
  assert.equal(saved.length, 0);
  assert.equal(nodes['#manual-account-dialog'].open, true);
  assert.equal(nodes['#manual-account-error'].textContent, 'Save failed.');
  assert.equal(submit.disabled, false);
  globalThis.fetch = async (url, options) => { calls.push([url, options]); return { ok: true, json: async () => ({ account }) }; };
  await nodes['#manual-account-form'].emit('submit');
  assert.equal(nodes['#manual-account-dialog'].open, false);
  assert.deepEqual(saved, [account]);
  assert.equal(calls[0][0], '/api/accounts');
  assert.deepEqual(JSON.parse(calls[0][1].body), { name: 'Checking', institutionName: 'Example Bank', type: 'depository', subtype: 'checking', currencyCode: 'USD', mask: '1234', currentBalance: 100 });
});

const importIds = ['#account-import-dialog', '#account-import-form', '#import-transactions', '#import-file', '#import-file-step', '#import-preview-step', '#import-csv-options', '#import-column-mapping', '#import-mapping-fields', '#import-date-format', '#import-amount-convention', '#import-back', '#import-next', '#account-import-error', '#import-preview-summary', '#import-preview-rows', '#import-preview-limit', '#account-import-message'];
test('optional account mask and balance can be left blank', async t => {
  const nodes = setup(t, ['#manual-account-dialog', '#manual-account-form', '#add-account', '#cancel-manual-account', '#manual-account-error']);
  const OriginalFormData = globalThis.FormData;
  globalThis.FormData = class { get(name) { return ({ name: 'Cash', institutionName: 'Personal', accountKind: 'depository:other', currencyCode: 'USD', mask: '', currentBalance: '' })[name]; } };
  t.after(() => { globalThis.FormData = OriginalFormData; });
  let body;
  globalThis.fetch = async (_url, options) => { body = JSON.parse(options.body); return { ok: true, json: async () => ({ account }) }; };
  workflow.initializeManualAccountCreation(async () => {});
  await nodes['#manual-account-form'].emit('submit');
  assert.equal(body.mask, undefined);
  assert.equal(body.currentBalance, null);
});
function importNodes(t) {
  const nodes = setup(t, importIds);
  nodes['#import-date-format'].value = 'mdy';
  nodes['#import-amount-convention'].value = 'inflow-positive';
  nodes['#import-file'].files = [new File(['Date,Description,Amount\n11/01/2026,Groceries,-10'], 'bank.csv')];
  return nodes;
}
const preview = { columns: ['Date', 'Description', 'Amount'], mapping: { dateColumn: 0, nameColumn: 1, amountColumn: 2, dateFormat: 'mdy', amountConvention: 'inflow-positive' }, transactions: [{ date: '2026-11-01', name: '<Groceries>', amount: 10, iso_currency_code: 'USD' }], total: 1, importable: 1, duplicates: 0, errors: [] };

test('Fidelity preview explains cash-only activity and ignored footer before confirmation', async t => {
  const nodes = importNodes(t);
  const notes = ['Fidelity history detected. Importing cash activity only; holdings are not imported.', 'Fidelity disclaimer and download footer ignored.'];
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ ...preview, notes }) });
  workflow.initializeAccountImport(account, async () => assert.fail('Preview must not commit'));
  await nodes['#account-import-form'].emit('submit');
  assert.match(nodes['#import-preview-summary'].textContent, /1 transactions found/);
  for (const note of notes) assert.ok(nodes['#import-preview-summary'].textContent.includes(note));
  assert.match(workflow.renderImportDialog(account), /Fidelity.*automatically/i);
});

test('import requires preview, supports Back, escapes data and preserves retry after failure', async t => {
  assert.equal(typeof workflow.initializeAccountImport, 'function');
  const nodes = importNodes(t), calls = [], imported = [];
  workflow.initializeAccountImport(account, async result => imported.push(result));
  globalThis.fetch = async (url, options) => { calls.push([url, JSON.parse(options.body)]); return { ok: true, json: async () => preview }; };
  await nodes['#import-transactions'].emit('click');
  await nodes['#account-import-form'].emit('submit');
  assert.equal(calls[0][0], '/api/accounts/manual-1/import/preview');
  assert.equal(nodes['#import-preview-step'].hidden, false);
  assert.equal(nodes['#import-file-step'].hidden, true);
  assert.equal(nodes['#import-next'].textContent, 'Import 1 transaction');
  assert.match(nodes['#import-preview-rows'].innerHTML, /&lt;Groceries&gt;/);
  assert.doesNotMatch(nodes['#import-preview-rows'].innerHTML, /<Groceries>/);
  await nodes['#import-back'].emit('click');
  assert.equal(nodes['#import-file-step'].hidden, false);
  assert.equal(nodes['#import-preview-step'].hidden, true);
  assert.equal(nodes['#import-next'].textContent, 'Preview transactions');
  await nodes['#account-import-form'].emit('submit');
  globalThis.fetch = async () => ({ ok: false, json: async () => ({ error: 'Import failed.' }) });
  await nodes['#account-import-form'].emit('submit');
  assert.equal(nodes['#account-import-dialog'].open, true);
  assert.equal(nodes['#account-import-error'].textContent, 'Import failed.');
  assert.equal(imported.length, 0);
  globalThis.fetch = async (url, options) => { calls.push([url, JSON.parse(options.body)]); return { ok: true, json: async () => ({ imported: 1, skipped: 0, account }) }; };
  await nodes['#account-import-form'].emit('submit');
  assert.equal(calls.at(-1)[0], '/api/accounts/manual-1/import');
  assert.deepEqual(calls.at(-1)[1], calls[1][1]);
  assert.equal(nodes['#account-import-dialog'].open, false);
  assert.equal(imported.length, 1);
});

test('invalid previews stay editable and block committing; cancelling does not write', async t => {
  assert.equal(typeof workflow.initializeAccountImport, 'function');
  const nodes = importNodes(t), calls = [];
  workflow.initializeAccountImport(account, async () => assert.fail('Must not import'));
  globalThis.fetch = async (url) => { calls.push(url); return { ok: true, json: async () => ({ ...preview, errors: ['Row 2: invalid date.'], importable: 0 }) }; };
  await nodes['#import-transactions'].emit('click');
  await nodes['#account-import-form'].emit('submit');
  assert.equal(nodes['#import-preview-step'].hidden, true);
  assert.equal(nodes['#import-column-mapping'].hidden, false);
  assert.match(nodes['#account-import-error'].textContent, /invalid date/);
  await nodes['#import-back'].emit('click');
  assert.equal(nodes['#account-import-dialog'].open, false);
  assert.deepEqual(calls, ['/api/accounts/manual-1/import/preview']);
});

test('file decoding preserves declared OFX Windows-1252 and rejects undecodable CSV', async () => {
  assert.equal(typeof workflow.readTransactionFile, 'function');
  const { readTransactionFile } = workflow;
  const header = 'OFXHEADER:100\r\nENCODING:USASCII\r\nCHARSET:1252\r\n\r\n<OFX><NAME>Caf';
  const bytes = new Uint8Array([...new TextEncoder().encode(header), 0xe9, ...new TextEncoder().encode('</NAME></OFX>')]);
  assert.match(await readTransactionFile(new File([bytes], 'legacy.ofx')), /Café/);
  assert.equal(await readTransactionFile(new File(['Café'], 'utf8.csv')), 'Café');
  await assert.rejects(readTransactionFile(new File([new Uint8Array([0x63, 0xe9])], 'unknown.csv')), /UTF-8/i);
  const utf16 = new Uint8Array([0xff, 0xfe, 0x43, 0, 0x61, 0, 0x66, 0, 0xe9, 0]);
  assert.equal(await readTransactionFile(new File([utf16], 'unicode.csv')), 'Café');
});
