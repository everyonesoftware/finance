import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { readFile, readdir } from 'node:fs/promises';
import { Hono } from 'hono';
import { applySqlMigration } from '../server/migration-utils.ts';
import { createBankAccountsRouter } from '../server/bank_accounts.ts';
import { encryptBankValue, decryptBankValue } from '../server/bank-crypto.ts';

const key = Buffer.alloc(32, 13);

test('USD coverage distinguishes unknown balances and excluded currencies without recording incomplete totals', async () => {
  const f = await fixture();
  try {
    assert.deepEqual(await f.read(), {currencyCode:'USD',total:null,accountCount:0,includedAccountCount:0,excludedAccountCount:0,unknownBalanceCount:0,points:[],history:{eligibleAccountCount:0,unsupportedAccountCount:0,reconstructedPointCount:0}});
    assert.equal(f.db.prepare('SELECT count(*) n FROM net_worth_observation').get().n,0);
    f.account({currencyCode:'EUR',currentBalance:1000});
    f.account({currencyCode:null});
    f.account({currencyCode:undefined});
    assert.equal((await f.read()).total,null);
    f.account({currentBalance:0});
    const complete = await f.read();
    assert.equal(complete.total,0);
    assert.equal(complete.excludedAccountCount,3);
    assert.equal(complete.includedAccountCount,1);
    assert.deepEqual(complete.points,[{date:'2026-11-12',total:0}]);
    f.setNow('2026-11-13T00:01:00Z');
    for (const currentBalance of [null,undefined,'42',{},Infinity]) f.account({currentBalance});
    const incomplete = await f.read();
    assert.equal(incomplete.total,null);
    assert.equal(incomplete.accountCount,9);
    assert.equal(incomplete.unknownBalanceCount,5);
    assert.equal(incomplete.excludedAccountCount,3);
    assert.deepEqual(incomplete.points,complete.points);
    assert.equal(f.db.prepare('SELECT count(*) n FROM net_worth_observation').get().n,1);
  } finally { f.db.close(); }
});

test('net worth sums cents, subtracts absolute credit and loan balances and preserves signed assets', async () => {
  const f = await fixture();
  try {
    for (const snapshot of [
      {currentBalance:10.10}, {currentBalance:0.20}, {type:'investment',currentBalance:50.30},
      {currentBalance:-2.15}, {type:'credit',currentBalance:3.12},
      {type:'credit',currentBalance:-4.23}, {type:'loan',currentBalance:5.34},
      {type:'loan',currentBalance:-6.45}, {currencyCode:'GBP',currentBalance:1000000},
    ]) f.account(snapshot);
    const data = await f.read();
    assert.equal(data.total,39.31);
    assert.equal(data.includedAccountCount,8);
    assert.equal(data.excludedAccountCount,1);
  } finally { f.db.close(); }
});
test('same UTC day replaces the latest observation and gaps stay unobserved across router recreation', async () => {
  const f = await fixture();
  try {
    const id = f.account();
    f.setNow('2026-11-10T23:59:00Z');
    assert.deepEqual((await f.read()).points,[{date:'2026-11-10',total:100}]);
    f.update(id,{currencyCode:'USD',currentBalance:250,type:'depository'});
    f.setNow('2026-11-10T23:59:59Z');
    assert.deepEqual((await f.read()).points,[{date:'2026-11-10',total:250}]);
    assert.equal(f.db.prepare('SELECT count(*) n FROM net_worth_observation').get().n,1);
    f.setNow('2026-11-12T01:00:00+01:00');
    const recreated = createBankAccountsRouter({database:f.db,getUserId:async()=> 'owner',getEncryptionKey:()=>key,now:()=>new Date('2026-11-12T00:00:00Z')});
    const response = await recreated.request('/net-worth');
    assert.equal(response.status,200);
    assert.deepEqual((await response.json()).points,[{date:'2026-11-10',total:250},{date:'2026-11-12',total:250}]);
    const originalDay = f.db.prepare('SELECT * FROM net_worth_observation ORDER BY created_at').all()[0];
    f.update(id,{currencyCode:'USD',currentBalance:300});
    await f.read();
    assert.deepEqual(f.db.prepare('SELECT * FROM net_worth_observation ORDER BY created_at').all()[0],originalDay);
    f.update(id,{currencyCode:'USD',currentBalance:null});
    const incomplete = await f.read();
    assert.equal(incomplete.total,null);
    assert.deepEqual(incomplete.points,[{date:'2026-11-10',total:250},{date:'2026-11-12',total:300}]);
  } finally { f.db.close(); }
});

test('history returns only actual observations in the inclusive last 365 UTC days, never future timestamps', async () => {
  const f = await fixture();
  try {
    f.account();
    const end = Date.parse('2026-11-12T12:00:00Z');
    for (let daysAgo=366; daysAgo>=0; daysAgo--) {
      f.setNow(new Date(end-daysAgo*86400000));
      await f.read();
    }
    const insert = f.db.prepare('INSERT INTO net_worth_observation(id,user_id,encrypted_data,created_at) VALUES(?,?,?,?)');
    insert.run('future-date','owner',f.enc({date:'2026-11-13',total:999}),Math.floor(end/1000)+86400);
    insert.run('future-time','owner',f.enc({date:'2026-11-11',total:999}),Math.floor(end/1000)+3600);
    insert.run('other-history','other',f.enc({date:'2026-11-11',total:777}),Math.floor(end/1000));
    const data = await f.read();
    assert.equal(data.points.length,365);
    assert.equal(data.points[0].date,new Date(end-364*86400000).toISOString().slice(0,10));
    assert.equal(data.points.at(-1).date,'2026-11-12');
    assert.ok(data.points.every(p=>p.total===100));
    assert.equal(new Set(data.points.map(p=>p.date)).size,365);
  } finally { f.db.close(); }
});

test('invalid encrypted observation payloads fail closed atomically with generic no-store errors', async () => {
  const f = await fixture();
  try {
    f.account();
    const insert = f.db.prepare('INSERT INTO net_worth_observation(id,user_id,encrypted_data,created_at) VALUES(?,?,?,?)');
    for (const payload of [
      {date:'2026-11-11',total:'private-invalid-total'},
      {date:'2026-02-30',total:1},
      {date:'2026-11-1',total:1},
      {date:'2026-11-11',total:null},
      null,
    ]) {
      insert.run('invalid','owner',f.enc(payload),1);
      const before = f.db.serialize();
      const response = await f.request();
      assert.equal(response.status,500);
      assert.equal(response.headers.get('cache-control'),'no-store');
      assert.deepEqual(await response.json(),{error:'Unable to read saved bank data.'});
      assert.deepEqual(f.db.serialize(),before);
      f.db.prepare('DELETE FROM net_worth_observation').run();
    }
    insert.run('invalid','owner','private-corrupt-ciphertext',1);
    const before = f.db.serialize();
    assert.equal((await f.request()).status,500);
    assert.deepEqual(f.db.serialize(),before);
  } finally { f.db.close(); }
});

test('undated snapshots do not reconstruct imported history or change saved snapshots', async () => {
  const f = await fixture();
  try {
    const id = f.account({currentBalance:432.10}, {provider:'manual'});
    const original = f.db.prepare('SELECT * FROM bank_account').all();
    const file = {fileName:'history.csv',content:'Date,Description,Amount\n2020-01-01,Historical credit,9000\n2020-01-02,Historical debit,-10'};
    const response = await f.router.request('/'+id+'/import',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(file)});
    assert.equal(response.status,200);
    assert.equal((await response.json()).imported,2);
    const originalTransactions = f.db.prepare('SELECT * FROM bank_transaction').all();
    assert.deepEqual((await f.read()).points,[{date:'2026-11-12',total:432.10}]);
    assert.deepEqual(f.db.prepare('SELECT * FROM bank_account').all(),original);
    assert.deepEqual(f.db.prepare('SELECT * FROM bank_transaction').all(),originalTransactions);
    f.db.prepare("UPDATE bank_account SET is_active=0 WHERE user_id='owner'").run();
    f.setNow('2026-11-13T12:00:00Z');
    const empty = await f.read();
    assert.equal(empty.total,null);
    assert.deepEqual(empty.points,[{date:'2026-11-12',total:432.10}]);
    assert.equal(f.db.prepare('SELECT count(*) n FROM net_worth_observation').get().n,1);
    const migration = await readFile(new URL('../server/migrations/0011_net_worth.sql',import.meta.url),'utf8');
    const saved = f.db.prepare('SELECT * FROM net_worth_observation').all();
    applySqlMigration(f.db,migration);
    applySqlMigration(f.db,migration);
    assert.deepEqual(f.db.prepare('SELECT * FROM net_worth_observation').all(),saved);
    f.db.prepare("DELETE FROM user WHERE id='owner'").run();
    assert.equal(f.db.prepare('SELECT count(*) n FROM net_worth_observation').get().n,0);
  } finally { f.db.close(); }
});

test('unsafe cent totals and failed persistence cannot create a misleading observation', async () => {
  const f = await fixture();
  try {
    const id = f.account({currentBalance:1e308});
    let before = f.db.serialize();
    let response = await f.request();
    assert.equal(response.status,500);
    assert.equal(response.headers.get('cache-control'),'no-store');
    assert.deepEqual(f.db.serialize(),before);
    f.update(id,{currencyCode:'USD',currentBalance:100});
    f.db.exec("CREATE TRIGGER reject_observation BEFORE INSERT ON net_worth_observation BEGIN SELECT RAISE(ABORT,'private failure'); END");
    before = f.db.serialize();
    response = await f.request();
    assert.equal(response.status,500);
    assert.deepEqual(await response.json(),{error:'Unable to read saved bank data.'});
    assert.deepEqual(f.db.serialize(),before);
  } finally { f.db.close(); }
});

async function fixture() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys=ON');
  const dir = new URL('../server/migrations/', import.meta.url);
  for (const file of (await readdir(dir)).filter(f => f.endsWith('.sql')).sort()) {
    applySqlMigration(db, await readFile(new URL(file, dir), 'utf8'));
  }
  for (const id of ['owner', 'other']) db.prepare('INSERT INTO user(id,name,email) VALUES(?,?,?)').run(id, id, id+'@example.test');
  let user = 'owner', now = new Date('2026-11-12T12:00:00Z'), sequence = 0;
  const enc = value => encryptBankValue(JSON.stringify(value), key);
  function account(snapshot = {}, {owner = 'owner', active = 1, provider = 'manual'} = {}) {
    const id = 'account-'+(++sequence);
    db.prepare('INSERT INTO bank_item(item_id,user_id,provider,encrypted_institution_name,encrypted_access_token) VALUES(?,?,?,?,?)')
      .run(id, owner, provider, encryptBankValue('Fixture Bank', key), encryptBankValue('', key));
    db.prepare('INSERT INTO bank_account(id,item_id,user_id,provider_account_id,encrypted_data,is_active,updated_at) VALUES(?,?,?,?,?,?,?)')
      .run(id, id, owner, 'provider-'+id, enc({name:id,type:'depository',currencyCode:'USD',currentBalance:100,...snapshot}), active, 1);
    return id;
  }
  const router = createBankAccountsRouter({database:db,getUserId:async()=>user,getEncryptionKey:()=>key,now:()=>now});
  const app = new Hono().route('/api/accounts', router);
  return {db,router,account,enc,setUser:id=>{user=id;},setNow:value=>{now=new Date(value);},
    update:(id,snapshot)=>db.prepare('UPDATE bank_account SET encrypted_data=? WHERE id=?').run(enc(snapshot),id),
    request:()=>app.request('/api/accounts/net-worth'),
    read:async()=>{const response=await app.request('/api/accounts/net-worth');assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');return response.json();}};
}

test('net worth authenticates, scopes active compatible accounts and records an encrypted UTC observation', async () => {
  const f = await fixture();
  try {
    f.account({currentBalance:12345.67});
    f.account({currentBalance:999}, {owner:'other'});
    f.account({currentBalance:999}, {active:0});
    f.account({currentBalance:999}, {provider:'legacy'});
    const original = f.db.prepare('SELECT * FROM bank_account').all();
    f.setUser(null);
    const denied = await f.request();
    assert.equal(denied.status,401);
    assert.equal(denied.headers.get('cache-control'),'no-store');
    f.setUser('owner');
    assert.deepEqual(await f.read(), {currencyCode:'USD',total:12345.67,accountCount:1,includedAccountCount:1,excludedAccountCount:0,unknownBalanceCount:0,points:[{date:'2026-11-12',total:12345.67}],history:{eligibleAccountCount:0,unsupportedAccountCount:1,reconstructedPointCount:0}});
    const rows = f.db.prepare('SELECT * FROM net_worth_observation').all();
    assert.equal(rows.length,1);
    assert.equal(rows[0].user_id,'owner');
    const saved = JSON.parse(decryptBankValue(rows[0].encrypted_data,key));
    assert.equal(saved.date,'2026-11-12');
    assert.equal(saved.total,12345.67);
    assert.ok(!JSON.stringify(rows).includes('12345.67'));
    assert.ok(!JSON.stringify(rows).includes('2026-11-12'));
    assert.deepEqual(f.db.prepare('SELECT * FROM bank_account').all(),original);
    f.setUser('other');
    assert.deepEqual((await f.read()).points,[{date:'2026-11-12',total:999}]);
    assert.equal(f.db.prepare('SELECT count(*) n FROM net_worth_observation').get().n,2);
  } finally { f.db.close(); }
});
