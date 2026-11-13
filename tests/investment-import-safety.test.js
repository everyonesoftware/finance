import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import Database from 'better-sqlite3';
import { createBankAccountsRouter } from '../server/bank_accounts.ts';
import { applySqlMigration } from '../server/migration-utils.ts';
import { decryptBankValue } from '../server/bank-crypto.ts';
import { fidelityHeader, fidelityRows } from './fixtures/fidelity-history.js';
import { investmentIncome, renderInvestmentIncome } from '../src/investments.ts';

test('production router saves and reads back all 201 Fidelity distributions without losing a cent', async t => {
  const f = await fixture(t);
  const amounts = [...Array(100).fill(1e12), .01, ...Array(100).fill(-1e12)];
  const rows = amounts.map((amount, index) => {
    const date = new Date(Date.UTC(2026, 10, 12 - index));
    const runDate = `${date.getUTCMonth()+1}/${date.getUTCDate()}/${date.getUTCFullYear()}`;
    return `${runDate},DIVIDEND RECEIVED EXAMPLE FUND (DEMO) (Cash),DEMO,EXAMPLE FUND,Cash,,0,,,,${amount},0,`;
  });
  const body = {fileName:'cancellation.csv',content:[fidelityHeader,...rows].join('\n')};
  const preview = await f.request(`/${f.account.id}/import/preview`, body);
  assert.equal(preview.status, 200, await preview.clone().text());
  const {previewToken} = await preview.json();
  const saved = await f.request(`/${f.account.id}/import`, {...body,previewToken});
  assert.equal(saved.status, 200, await saved.clone().text());
  assert.equal((await saved.json()).imported, 201);
  assert.equal(f.database.prepare('SELECT count(*) n FROM bank_transaction').get().n, 201);
  const readback = await f.request(`/${f.account.id}/transactions`, undefined, 'GET');
  assert.equal(readback.status, 200);
  const {transactions} = await readback.json();
  assert.equal(transactions.length, 201);
  assert.deepEqual(transactions.map(tx=>tx.amount), amounts.map(n=>-n));
  assert.ok(transactions.every(tx=>tx.investmentActivity.kind==='income' && tx.investmentActivity.distribution==='unknown'));
  assert.deepEqual(investmentIncome(f.account,transactions),{total:1,cash:0,reinvested:0,unknown:1,count:201,excluded:0});
  assert.match(renderInvestmentIncome(f.account,transactions), /\$0\.01/);
});

async function fixture(t) {
  const database = new Database(':memory:');
  t.after(() => database.close());
  database.pragma('foreign_keys=ON');
  const dir = new URL('../server/migrations/', import.meta.url);
  for (const name of readdirSync(dir).filter(name => name.endsWith('.sql')).sort()) applySqlMigration(database, readFileSync(new URL(name, dir), 'utf8'));
  database.prepare('INSERT INTO user(id,name,email) VALUES(?,?,?)').run('owner', 'Example', 'example@test.invalid');
  const key = Buffer.alloc(32, 53);
  const router = createBankAccountsRouter({ database, getUserId: async () => 'owner', getEncryptionKey: () => key });
  const request = (path, body, method = 'POST') => router.request(new Request('http://localhost' + path, { method, headers: { 'content-type': 'application/json', origin: 'http://localhost' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
  const created = await request('/', { name: 'Brokerage', institutionName: 'Synthetic Fidelity', type: 'investment', subtype: 'brokerage', currencyCode: 'USD', currentBalance: 100, balanceDate: '2026-10-30' });
  assert.equal(created.status, 201);
  const account = (await created.json()).account;
  return { database, request, account, key };
}
const original = { fileName: 'history.csv', content: fidelityHeader + '\n' + fidelityRows[0] };
const altered = { ...original, content: original.content.replace('Cash,10,2.5,', 'Cash,10,3.5,') };

test('single-file approval binds security metadata as well as legacy cash identity', async t => {
  const f = await fixture(t);
  const preview = await f.request(`/${f.account.id}/import/preview`, original);
  const { previewToken } = await preview.json();
  const changed = await f.request(`/${f.account.id}/import`, { ...altered, previewToken });
  assert.equal(changed.status, 409);
  assert.equal(f.database.prepare('SELECT count(*) n FROM bank_transaction').get().n, 0);
});

test('batch approval binds security metadata while keeping account values unchanged', async t => {
  const f = await fixture(t);
  const files = [{ ...original, accountId: f.account.id }];
  const preview = await f.request('/import-batch/preview', { files });
  const { previewToken } = await preview.json();
  const changed = await f.request('/import-batch', { files: [{ ...altered, accountId: f.account.id }], previewToken });
  assert.equal(changed.status, 409);
  assert.equal(f.database.prepare('SELECT count(*) n FROM bank_transaction').get().n, 0);
});

test('new Fidelity activity metadata persists encrypted, reloads and remains duplicate-safe', async t => {
  const f = await fixture(t);
  const saved = await f.request(`/${f.account.id}/import`, original);
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).account.currentBalance, 100, 'a trade cash amount cannot revalue a portfolio');
  const ciphertext = f.database.prepare('SELECT encrypted_data FROM bank_transaction').get().encrypted_data;
  assert.ok(!ciphertext.includes('DEMO') && !ciphertext.includes('investmentActivity'));
  const stored = JSON.parse(decryptBankValue(ciphertext, f.key));
  assert.equal(stored.investmentActivity.quantity, 2.5);
  assert.equal(stored.investmentActivity.kind, 'trade');
  const detail = await f.request(`/${f.account.id}/transactions`, undefined, 'GET');
  assert.equal((await detail.json()).transactions[0].investmentActivity.quantity, 2.5);
  const again = await f.request(`/${f.account.id}/import`, original);
  const result = await again.json();
  assert.equal(result.imported, 0);
  assert.equal(result.skipped, 1);
});
