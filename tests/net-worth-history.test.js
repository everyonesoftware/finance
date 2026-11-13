import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { createBankAccountsRouter } from '../server/bank_accounts.ts';
import { applySqlMigration } from '../server/migration-utils.ts';
import { encryptBankValue, decryptBankValue } from '../server/bank-crypto.ts';

function fixture(t) {
  const statements = [];
  const db = new Database(':memory:', { verbose: sql => statements.push(sql) });
  db.pragma('foreign_keys=ON');
  const directory = new URL('../server/migrations/', import.meta.url);
  for (const file of readdirSync(directory).filter(f => f.endsWith('.sql')).sort()) {
    applySqlMigration(db, readFileSync(new URL(file, directory), 'utf8'));
  }
  t.after(() => db.close());
  for (const id of ['owner', 'other']) db.prepare('INSERT INTO user(id,name,email) VALUES(?,?,?)').run(id,id,id+'@example.test');
  const key = Buffer.alloc(32, 19);
  let user = 'owner', now = new Date('2026-11-12T12:00:00Z'), sequence = 0;
  const router = () => createBankAccountsRouter({ database: db, getUserId: async () => user, getEncryptionKey: () => key, now: () => now });
  let app = router();
  const send = (path, body, method = 'POST') => app.request(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const create = async (fields = {}) => {
    const response = await send('/', { name: 'Checking', institutionName: 'Example', type: 'depository', subtype: 'checking', currencyCode: 'USD', currentBalance: 100, balanceDate: '2026-11-10', ...fields });
    assert.equal(response.status, 201);
    return (await response.json()).account;
  };
  const read = async () => { const response = await app.request('/net-worth'); assert.equal(response.status, 200); return response.json(); };
  const importFile = async (account, content) => {
    const response = await send('/'+account.id+'/import', { fileName: 'history.csv', content: 'Date,Description,Amount,ID\n'+content });
    assert.equal(response.status, 200);
    return response.json();
  };
  const transaction = (account, fields = {}) => {
    const id = 'direct-'+(++sequence);
    const payload = { date: '2026-11-09', amount: 10, iso_currency_code: 'USD', pending: false, ...fields };
    db.prepare('INSERT INTO bank_transaction(transaction_id,item_id,user_id,account_id,encrypted_data) VALUES(?,?,?,?,?)')
      .run(id, account.itemId, user, account.providerAccountId, encryptBankValue(JSON.stringify(payload), key));
    return id;
  };
  const updateTransaction = (id, fields) => {
    const row = db.prepare('SELECT encrypted_data FROM bank_transaction WHERE transaction_id=?').get(id);
    const payload = { ...JSON.parse(decryptBankValue(row.encrypted_data, key)), ...fields };
    db.prepare('UPDATE bank_transaction SET encrypted_data=? WHERE transaction_id=?').run(encryptBankValue(JSON.stringify(payload), key), id);
  };
  return { db, key, statements, send, create, read, importFile, transaction, updateTransaction,
    recreate: () => { app = router(); }, setNow: value => { now = new Date(value); }, setUser: value => { user = value; },
    request: () => app.request('/net-worth'),
    cache: () => db.prepare('SELECT * FROM net_worth_history_cache WHERE user_id=?').get(user),
  };
}

const at = (data, date) => data.points.find(point => point.date === date);

test('reconstructs end-of-day history backward and forward with cent precision and observed precedence', async t => {
  const f = fixture(t), account = await f.create();
  await f.importFile(account, '2026-11-08,First,-5,first\n2026-11-09,Purchase,-0.1,a\n2026-11-09,Purchase,-0.2,b\n2026-11-10,Reference day,-20,same\n2026-11-11,Deposit,12,later');
  const data = await f.read();
  assert.deepEqual(at(data,'2026-11-08'), {date:'2026-11-08',total:120.3,source:'reconstructed'});
  assert.equal(at(data,'2026-11-09').total,120);
  assert.equal(at(data,'2026-11-10').total,100);
  assert.equal(at(data,'2026-11-11').total,112);
  assert.deepEqual(at(data,'2026-11-12'), {date:'2026-11-12',total:112});
  assert.equal(at(data,'2026-11-07'),undefined,'do not fabricate coverage before earliest imported day');
  assert.deepEqual(data.history,{eligibleAccountCount:1,unsupportedAccountCount:0,reconstructedPointCount:4});
  assert.equal(f.db.prepare('SELECT count(*) n FROM net_worth_observation').get().n,1,'generated points are not observations');
});

test('cache hits survive router recreation without rereading transactions; next UTC day expires cache', async t => {
  const f = fixture(t), account = await f.create();
  await f.importFile(account, '2026-11-08,First,-5,first');
  const first = await f.read(), cached = f.cache();
  assert.ok(cached);
  assert.ok(!JSON.stringify(cached).includes('reconstructed'));
  assert.ok(!JSON.stringify(cached).includes('2026-11-08'));
  f.recreate(); f.statements.length = 0;
  assert.deepEqual(await f.read(), first);
  assert.deepEqual(f.cache(),cached,'no cache rewrite on hit');
  assert.ok(!f.statements.some(sql => /SELECT[\s\S]*\bFROM bank_(?:account|transaction)\b/i.test(sql)), 'hit must bypass account derivation and transaction decryption');
  f.setNow('2026-11-13T00:00:01Z');
  const next = await f.read();
  assert.notEqual(f.cache().encrypted_data,cached.encrypted_data);
  assert.deepEqual(at(next,'2026-11-13'),{date:'2026-11-13',total:100});
  assert.equal(f.db.prepare('SELECT count(*) n FROM net_worth_history_cache').get().n,1);
});

test('single/batch imports invalidate once needed; duplicate-only imports and previews keep cache', async t => {
  const f = fixture(t), account = await f.create();
  const content = '2026-11-08,First,-5,first';
  await f.importFile(account,content); await f.read(); const cached = f.cache();
  const preview = await f.send('/'+account.id+'/import/preview',{fileName:'history.csv',content:'Date,Description,Amount,ID\n'+content});
  assert.equal(preview.status,200); assert.deepEqual(f.cache(),cached);
  await f.importFile(account,content); assert.deepEqual(f.cache(),cached);
  await f.importFile(account,'2026-11-09,Second,-2,second'); assert.equal(f.cache(),undefined);
  assert.equal(at(await f.read(),'2026-11-08').total,102);
  const batch = await f.send('/import-batch',{files:[{accountId:account.id,fileName:'batch.csv',content:'Date,Description,Amount,ID\n2026-11-11,Third,-3,third'}]});
  assert.equal(batch.status,200); assert.equal(f.cache(),undefined);
  assert.equal((await f.read()).total,97);
});

test('transaction edits/deletes, balance changes, account activity and provider changes invalidate cache', async t => {
  const f = fixture(t), account = await f.create(), id = f.transaction(account);
  assert.equal(at(await f.read(),'2026-11-09').total,100);
  f.updateTransaction(id,{date:'2026-11-08',amount:7}); assert.equal(f.cache(),undefined);
  assert.equal(at(await f.read(),'2026-11-08').total,100);
  assert.equal((await f.send('/'+account.id+'/balance',{currentBalance:200,balanceDate:'2026-11-10'},'PATCH')).status,200);
  assert.equal(f.cache(),undefined); assert.equal((await f.read()).total,200);
  f.db.prepare('DELETE FROM bank_transaction WHERE transaction_id=?').run(id); assert.equal(f.cache(),undefined);
  const noTransactions = await f.read(); assert.equal(at(noTransactions,'2026-11-09'),undefined);
  f.db.prepare('UPDATE bank_account SET is_active=0 WHERE id=?').run(account.id); assert.equal(f.cache(),undefined);
  assert.equal((await f.read()).total,null);
  f.db.prepare('UPDATE bank_account SET is_active=1 WHERE id=?').run(account.id); await f.read();
  f.db.prepare("UPDATE bank_item SET provider='legacy' WHERE item_id=?").run(account.itemId); assert.equal(f.cache(),undefined);
  assert.equal((await f.read()).accountCount,0);
});

test('reconstructs only overlapping account coverage and handles signed credit/loan overpayments', async t => {
  const f = fixture(t), cash = await f.create(), credit = await f.create({type:'credit',currentBalance:-10,balanceDate:'2026-11-09'}), loan = await f.create({type:'loan',currentBalance:20});
  f.transaction(cash,{date:'2026-11-08',amount:5});
  f.transaction(credit,{date:'2026-11-07',amount:-3});
  f.transaction(loan,{date:'2026-11-09',amount:7});
  const data = await f.read();
  assert.equal(at(data,'2026-11-08'),undefined,'all USD accounts must have coverage');
  assert.equal(at(data,'2026-11-09').total,90);
  assert.equal(data.total,90);
  assert.equal(data.history.eligibleAccountCount,3);
});

test('unverified/undated/saved and investment accounts block aggregate backfill, not actual observations', async t => {
  for (const kind of ['unverified','undated','saved','investment','unknown']) {
    const f = fixture(t), account = await f.create(); f.transaction(account);
    const blocked = await f.create(kind === 'investment' ? {type:'investment'} : kind === 'unverified' ? {currentBalance:null} : {});
    if (kind === 'undated' || kind === 'unknown') {
      const snapshot = {name:'Old',type:'depository',currencyCode:'USD',currentBalance:kind==='unknown'?null:100};
      f.db.prepare('UPDATE bank_account SET encrypted_data=? WHERE id=?').run(encryptBankValue(JSON.stringify(snapshot),f.key),blocked.id);
    }
    if (kind === 'saved') f.db.prepare("UPDATE bank_item SET provider='saved' WHERE item_id=?").run(blocked.itemId);
    const data = await f.read();
    assert.equal(data.history.reconstructedPointCount,0,kind);
    assert.equal(data.history.unsupportedAccountCount,1,kind);
    assert.equal(data.points.length,kind==='unknown'?0:1,kind);
    assert.equal(data.points.some(point=>point.source==='reconstructed'),false);
  }
});

test('pending activity is ignored, non-USD accounts excluded, and future posted rows do not backfill', async t => {
  const f = fixture(t), account = await f.create();
  f.transaction(account,{date:'2025-01-01',amount:900,pending:true});
  f.transaction(account,{date:'2026-11-09',amount:2});
  await f.create({currencyCode:'EUR',type:'investment'});
  const data = await f.read();
  assert.equal(data.points[0].date,'2026-11-09');
  assert.equal(data.excludedAccountCount,1); assert.equal(data.history.unsupportedAccountCount,0);
  f.transaction(account,{date:'2026-11-13',amount:3});
  const future = await f.read();
  assert.equal(future.history.reconstructedPointCount,0,'future posted activity makes anchor-derived current balance inconsistent; decline backfill');
});

test('bounds daily generated history to 365 days and preserves recorded observations after historical corrections', async t => {
  const f = fixture(t), account = await f.create();
  f.transaction(account,{date:'2020-01-01',amount:100});
  let data = await f.read();
  assert.equal(data.points.length,365); assert.equal(data.points[0].date,'2025-11-13');
  const saved = f.db.prepare('SELECT * FROM net_worth_observation').get();
  f.setNow('2026-11-13T12:00:00Z');
  assert.equal((await f.send('/'+account.id+'/balance',{currentBalance:200,balanceDate:'2026-11-10'},'PATCH')).status,200);
  data = await f.read();
  assert.equal(at(data,'2026-11-11').total,200);
  assert.deepEqual(at(data,'2026-11-12'),{date:'2026-11-12',total:100});
  assert.deepEqual(f.db.prepare('SELECT * FROM net_worth_observation WHERE id=?').get(saved.id),saved);
});

test('cache is owner-scoped, invalidation rolls back with writes, and owner deletion cascades', async t => {
  const f = fixture(t), account = await f.create(); f.transaction(account); await f.read();
  const ownerCache = f.cache();
  assert.throws(() => f.db.transaction(() => { f.db.prepare('UPDATE bank_account SET is_active=0 WHERE id=?').run(account.id); throw Error('rollback'); })());
  assert.deepEqual(f.cache(),ownerCache);
  f.setUser('other'); const other = await f.create(); f.transaction(other); await f.read(); const otherCache = f.cache();
  f.setUser('owner'); f.transaction(account); assert.equal(f.cache(),undefined);
  f.setUser('other'); assert.deepEqual(f.cache(),otherCache);
  f.setUser(null); assert.equal((await f.request()).status,401);
  f.setUser('other'); f.db.prepare("DELETE FROM user WHERE id='other'").run(); assert.equal(f.cache(),undefined);
});

test('failed observation or cache persistence rolls back the complete read/rebuild', async t => {
  const f = fixture(t), account = await f.create(); f.transaction(account);
  for (const table of ['net_worth_observation','net_worth_history_cache']) {
    f.db.exec(`CREATE TRIGGER fail_write BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'private failure'); END`);
    const before = f.db.serialize(), response = await f.request();
    assert.equal(response.status,500); assert.equal(response.headers.get('cache-control'),'no-store');
    assert.deepEqual(await response.json(),{error:'Unable to read saved bank data.'});
    assert.deepEqual(f.db.serialize(),before);
    f.db.exec('DROP TRIGGER fail_write');
  }
});

test('account creation/deletion and currency changes invalidate cached aggregate coverage', async t => {
  const f = fixture(t), first = await f.create(); f.transaction(first); await f.read();
  const second = await f.create({currencyCode:'EUR'}); assert.equal(f.cache(),undefined);
  assert.equal((await f.read()).excludedAccountCount,1);
  const row = f.db.prepare('SELECT encrypted_data FROM bank_account WHERE id=?').get(second.id);
  const payload = {...JSON.parse(decryptBankValue(row.encrypted_data,f.key)),currencyCode:'USD'};
  f.db.prepare('UPDATE bank_account SET encrypted_data=? WHERE id=?').run(encryptBankValue(JSON.stringify(payload),f.key),second.id);
  assert.equal(f.cache(),undefined);
  assert.equal((await f.read()).points[0].date,'2026-11-10','new account shortens common coverage');
  f.db.prepare('DELETE FROM bank_item WHERE item_id=?').run(second.itemId);
  assert.equal(f.cache(),undefined);
  assert.equal((await f.read()).points[0].date,'2026-11-09');
});

test('disposable corrupt or obsolete caches rebuild, and migration is idempotent without touching observations', async t => {
  const f = fixture(t), account = await f.create(); f.transaction(account); const first = await f.read();
  for (const encrypted of ['corrupt-cache', encryptBankValue(JSON.stringify({version:0}),f.key), encryptBankValue('null',f.key)]) {
    f.db.prepare('UPDATE net_worth_history_cache SET encrypted_data=?').run(encrypted);
    assert.deepEqual(await f.read(),first);
    assert.notEqual(f.cache().encrypted_data,encrypted);
  }
  const observations = f.db.prepare('SELECT * FROM net_worth_observation').all(), cached = f.cache();
  const migration = readFileSync(new URL('../server/migrations/0013_net_worth_history_cache.sql',import.meta.url),'utf8');
  applySqlMigration(f.db,migration); applySqlMigration(f.db,migration);
  assert.deepEqual(f.cache(),cached);
  assert.deepEqual(f.db.prepare('SELECT * FROM net_worth_observation').all(),observations);
});

test('invalid historical posted rows decline reconstruction instead of fabricating values', async t => {
  for (const fields of [{date:'2026-02-30'},{amount:0.001},{iso_currency_code:'EUR'}]) {
    const f = fixture(t), account = await f.create(); f.transaction(account,fields);
    const data = await f.read();
    assert.equal(data.history.unsupportedAccountCount,1);
    assert.equal(data.history.reconstructedPointCount,0);
    assert.equal(data.points.length,1);
  }
});

test('large encrypted transaction fixture uses a bounded cache and no transaction reads on repeat', async t => {
  const f = fixture(t), account = await f.create();
  const count = 10000;
  f.db.transaction(() => {
    for (let i=0;i<count;i++) f.transaction(account,{date:new Date(Date.parse('2025-01-01')+(i%680)*86400000).toISOString().slice(0,10),amount:0.01});
  })();
  const start = performance.now(); await f.read(); const coldMs = performance.now()-start;
  const bytes = Buffer.byteLength(f.cache().encrypted_data,'utf8');
  f.statements.length=0;
  const warmStart = performance.now(); const data = await f.read(); const warmMs = performance.now()-warmStart;
  assert.equal(data.points.length,365);
  assert.equal(f.db.prepare('SELECT count(*) n FROM net_worth_history_cache').get().n,1);
  assert.ok(bytes<65536,'one aggregate cache stays below 64 KiB for a 365-day chart');
  assert.ok(!f.statements.some(sql=>/SELECT[\s\S]*\bFROM bank_transaction\b/i.test(sql)));
  t.diagnostic(JSON.stringify({transactions:count,coldMs:Number(coldMs.toFixed(2)),warmMs:Number(warmMs.toFixed(2)),cacheBytes:bytes}));
});
