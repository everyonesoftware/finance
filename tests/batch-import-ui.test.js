import assert from 'node:assert/strict';
import test from 'node:test';
import * as batch from '../src/batch-import.ts';
import { renderTransactionsPage } from '../src/transactions-page.ts';

const account = { id: 'manual-1', institutionName: 'Example Bank', name: 'Checking', mask: '1234', canImport: true };
class Element {
  value = ''; files = []; hidden = false; disabled = false; textContent = ''; innerHTML = ''; open = false; handlers = {};
  addEventListener(name, fn) { (this.handlers[name] ??= []).push(fn); }
  async emit(name, target = this) { for (const fn of this.handlers[name] ?? []) await fn({ preventDefault() {}, target }); }
  querySelectorAll() { return []; }
  showModal() { this.open = true; }
  close() { this.open = false; }
}
function setup(t) {
  const ids = ['batch-import-dialog', 'batch-import-form', 'open-batch-import', 'batch-import-files', 'batch-import-rows', 'batch-import-summary', 'batch-import-error', 'batch-import-confirm', 'batch-import-cancel'];
  const nodes = Object.fromEntries(ids.map(id => ['#' + id, new Element()]));
  const previous = globalThis.document;
  globalThis.document = { querySelector: id => nodes[id] ?? null };
  t.after(() => { globalThis.document = previous; });
  return nodes;
}
const result = (extra = {}) => ({ fileName: 'checking.csv', accountId: account.id, status: 'ready', reason: 'Account selected.', total: 140, duplicates: 120, importable: 20, errors: [], columns: [], mapping: null, ...extra });

test('Transactions page includes styled import button and multi-file review dialog', () => {
  const html = renderTransactionsPage({ displayName: 'Tester', username: 'tester' });
  assert.match(html, /id="open-batch-import"[^>]*aria-label="Import transactions"[^>]*>[\s\S]*?<svg/);
  const stickyStart = html.indexOf('class="transactions-sticky-controls"');
  const resultsStart = html.indexOf('<section class="panel transactions-results"');
  assert.ok(stickyStart >= 0);
  const stickyControls = html.slice(stickyStart, resultsStart);
  assert.match(stickyControls, /class="page-heading transactions-page-heading"[\s\S]*id="open-batch-import"[\s\S]*<\/section>/);
  assert.doesNotMatch(html, /id="all-transactions-title"|transactions-results-heading/);
  assert.match(stickyControls, /id="all-transactions-count" class="transaction-results-status" aria-live="polite"/);
  assert.match(html, /<section class="panel transactions-results" aria-label="Transactions">/);
  assert.equal((html.match(/id="open-batch-import"/g) ?? []).length, 1);
  assert.match(html, /id="batch-import-dialog"/);
  assert.match(html, /id="batch-import-files"[^>]*multiple/);
  for (const label of ['File', 'Destination account', 'Status', 'Transactions']) assert.ok(html.includes(`>${label}</th>`));
});

test('batch dialog previews on file selection, requires confirmation, and refreshes after save', async t => {
  assert.equal(typeof batch.initializeBatchImport, 'function');
  const nodes = setup(t), calls = [], saved = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push([url, JSON.parse(options.body)]);
    return { ok: true, json: async () => url.endsWith('/preview') ? { files: [result()] } : { files: [{ fileName: 'checking.csv', accountId: account.id, imported: 20, skipped: 120 }], imported: 20, skipped: 120 } };
  });
  batch.initializeBatchImport(() => [account], async () => saved.push(true));
  await nodes['#open-batch-import'].emit('click');
  assert.equal(nodes['#batch-import-dialog'].open, true);
  nodes['#batch-import-files'].files = [new File(['Date,Description,Amount\n11/01/2026,Purchase,-1'], 'checking.csv')];
  await nodes['#batch-import-files'].emit('change');
  assert.deepEqual(calls.map(c => c[0]), ['/api/accounts/import-batch/preview']);
  assert.match(nodes['#batch-import-rows'].innerHTML, /Import 20 of 140 transactions/);
  assert.equal(nodes['#batch-import-confirm'].disabled, false);
  await nodes['#batch-import-form'].emit('submit');
  assert.equal(calls.at(-1)[0], '/api/accounts/import-batch');
  assert.equal(calls.at(-1)[1].files[0].accountId, account.id);
  assert.equal(saved.length, 1);
  assert.equal(nodes['#batch-import-dialog'].open, false);
});

test('uncertain destinations block approval until selected and re-previewed; failures remain retryable', async t => {
  assert.equal(typeof batch.initializeBatchImport, 'function');
  const nodes = setup(t), calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const body = JSON.parse(options.body); calls.push([url, body]);
    if (!url.endsWith('/preview')) return { ok: false, json: async () => ({ error: 'Import failed.' }) };
    return { ok: true, json: async () => ({ files: [result(body.files[0].accountId ? {} : { accountId: null, status: 'needs-account', importable: 0, reason: 'Choose an account.' })] }) };
  });
  batch.initializeBatchImport(() => [account, { ...account, id: 'saved', canImport: false }], async () => assert.fail('No save'));
  await nodes['#open-batch-import'].emit('click');
  nodes['#batch-import-files'].files = [new File(['Date,Description,Amount'], '<unsafe>.csv')];
  await nodes['#batch-import-files'].emit('change');
  assert.equal(nodes['#batch-import-confirm'].disabled, true);
  assert.match(nodes['#batch-import-rows'].innerHTML, /&lt;unsafe&gt;.csv/);
  assert.doesNotMatch(nodes['#batch-import-rows'].innerHTML, /value="saved"/);
  await nodes['#batch-import-form'].emit('submit');
  assert.equal(calls.length, 1);
  await nodes['#batch-import-rows'].emit('change', { dataset: { batchAccount: '0' }, value: account.id });
  assert.equal(calls.at(-1)[1].files[0].accountId, account.id);
  assert.equal(nodes['#batch-import-confirm'].disabled, false);
  await nodes['#batch-import-form'].emit('submit');
  assert.equal(nodes['#batch-import-error'].textContent, 'Import failed.');
  assert.equal(nodes['#batch-import-confirm'].disabled, false);
  await nodes['#batch-import-cancel'].emit('click');
  assert.equal(nodes['#batch-import-dialog'].open, false);
});

test('removing overlapping files re-previews remaining counts and all-duplicate batches cannot submit', async t => {
  const nodes = setup(t), calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const body = JSON.parse(options.body); calls.push(body);
    return { ok: true, json: async () => ({ files: body.files.map(file => result({ fileName: file.fileName, total: 1, importable: 0, duplicates: 1 })) }) };
  });
  batch.initializeBatchImport(() => [account], async () => assert.fail('No new transactions'));
  await nodes['#open-batch-import'].emit('click');
  nodes['#batch-import-files'].files = [new File(['x'], 'one.csv'), new File(['x'], 'two.csv')];
  await nodes['#batch-import-files'].emit('change');
  assert.equal(nodes['#batch-import-confirm'].disabled, true);
  assert.match(nodes['#batch-import-summary'].textContent, /No new transactions/);
  await nodes['#batch-import-rows'].emit('click', { dataset: { batchRemove: '0' } });
  assert.deepEqual(calls.at(-1).files.map(file => file.fileName), ['two.csv']);
  assert.match(nodes['#batch-import-rows'].innerHTML, /Import 0 of 1 transactions/);
});

test('editing CSV mapping preserves detected columns and keeps options open for corrections', async t => {
  const nodes = setup(t), calls = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const body = JSON.parse(options.body); calls.push(body);
    return { ok: true, json: async () => ({ files: [result({ columns: ['Date', 'Name', 'Amount'], mapping: { dateColumn: 0, nameColumn: 1, amountColumn: 2, dateFormat: 'mdy', amountConvention: 'inflow-positive' } })] }) };
  });
  batch.initializeBatchImport(() => [account], async () => {});
  await nodes['#open-batch-import'].emit('click');
  nodes['#batch-import-files'].files = [new File(['x'], 'one.csv')];
  await nodes['#batch-import-files'].emit('change');
  assert.match(nodes['#batch-import-rows'].innerHTML, /aria-label="Date for one.csv"><option value="">Not used<\/option><option value="0" selected>/);
  await nodes['#batch-import-rows'].emit('change', { dataset: { batchCsv: '0', field: 'dateFormat' }, value: 'ymd' });
  assert.deepEqual(calls.at(-1).files[0].csv, { dateColumn: 0, nameColumn: 1, amountColumn: 2, dateFormat: 'ymd', amountConvention: 'inflow-positive' });
  assert.match(nodes['#batch-import-rows'].innerHTML, /<details class="batch-csv-options" open>/);
});

test('failed recalculation hides stale counts and offers a preview retry without importing', async t => {
  const nodes = setup(t), calls = [];
  let fail = false;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push([url, JSON.parse(options.body)]);
    if (fail) throw Error('Network unavailable.');
    return { ok: true, json: async () => ({ files: [result()] }) };
  });
  batch.initializeBatchImport(() => [account, { ...account, id: 'manual-2' }], async () => assert.fail('Preview only'));
  await nodes['#open-batch-import'].emit('click');
  nodes['#batch-import-files'].files = [new File(['x'], 'one.csv')];
  await nodes['#batch-import-files'].emit('change');
  fail = true;
  await nodes['#batch-import-rows'].emit('change', { dataset: { batchAccount: '0' }, value: 'manual-2' });
  assert.doesNotMatch(nodes['#batch-import-rows'].innerHTML, />Ready<|Import 20 of 140/);
  assert.equal((nodes['#batch-import-rows'].innerHTML.match(/ selected/g) ?? []).length, 3);
  assert.equal(nodes['#batch-import-confirm'].textContent, 'Retry preview');
  assert.equal(nodes['#batch-import-confirm'].disabled, false);
  fail = false;
  await nodes['#batch-import-form'].emit('submit');
  assert.ok(calls.every(([url]) => url.endsWith('/preview')));
});
