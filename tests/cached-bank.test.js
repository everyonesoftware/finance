import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { readFile, readdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Hono } from 'hono';
import { applySqlMigration } from '../server/migration-utils.ts';
import { createBankAccountsRouter } from '../server/bank_accounts.ts';
import { encryptBankValue } from '../server/bank-crypto.ts';



test('every bank read and unknown mutation authenticates before returning JSON', async () => {
  const f = await fixture();
  try {
    f.setUser(null);
    for (const path of [...readPaths, ...removedPaths]) {
      for (const method of ['GET','POST','PUT','PATCH','DELETE','OPTIONS']) {
        const response = await f.router.request(path, {method});
        assert.equal(response.status,401,method+' '+path);
        assert.equal(response.headers.get('cache-control'),'no-store');
        assert.deepEqual(await response.json(),{error:'Authentication required.'});
      }
    }
    f.setUser('owner');
    const before = f.db.serialize();
    for (const path of [...readPaths, ...removedPaths]) {
      for (const method of ['POST','PUT','PATCH','DELETE','OPTIONS']) {
        const response = await f.router.request(path, {method,headers:{origin:'https://untrusted.example'}});
        const isCreation = method === 'POST' && path === '/';
        assert.equal(response.status,isCreation ? 403 : 404,method+' '+path);
        assert.equal(response.headers.get('cache-control'),'no-store');
        if (isCreation) assert.match((await response.json()).error, /origin/i);
        else assert.deepEqual(await response.json(),{error:'API endpoint not found.'});
      }
    }
    for (const path of removedPaths) {
      const response = await f.router.request(path);
      assert.equal(response.status,404);
      assert.deepEqual(await response.json(),{error:'API endpoint not found.'});
    }
    assert.deepEqual(f.db.serialize(),before);
  } finally {f.db.close();}
});

test('cached transaction reads are owner-scoped, exclude incompatible rows and retain recent/all shapes', async () => {
  const f = await fixture();
  try {
    for (let n=0;n<60;n++) f.transaction('history-'+n,'saved','stable-id','owner','2026-10-01');
    const all = await (await f.router.request('/transactions/all')).json();
    assert.equal(all.configured,false);
    assert.equal(all.transactions.length,61);
    assert.deepEqual(all.accounts.map(a=>a.id),['stable-id']);
    const recent = await (await f.router.request('/transactions')).json();
    assert.equal(recent.transactions.length,10);
    assert.equal(recent.transactions[0].transaction_id,'saved-tx');
    const detail = await (await f.router.request('/stable-id/transactions')).json();
    assert.equal(detail.account.id,'stable-id');
    assert.equal(detail.transactions.length,50);
    assert.deepEqual(detail.accounts.map(a=>a.id),['stable-id']);
    for (const id of ['foreign-id','external-stable-id','old-id','inactive','missing']) {
      const response = await f.router.request('/'+id+'/transactions');
      assert.equal(response.status,404,id);
      assert.deepEqual(await response.json(),{error:'Account not found.'});
    }
    f.setUser('other');
    assert.deepEqual((await (await f.router.request('/')).json()).accounts.map(a=>a.id),['foreign-id']);
    assert.deepEqual((await (await f.router.request('/items')).json()).connections.map(i=>i.itemId),['foreign']);
    assert.deepEqual((await (await f.router.request('/transactions/all')).json()).transactions.map(t=>t.transaction_id),['foreign-tx']);
    assert.equal((await f.router.request('/stable-id/transactions')).status,404);
    assert.equal((await f.router.request('/foreign-id/transactions')).status,200);
  } finally {f.db.close();}
});

test('metadata migration discovers historical columns and is idempotent without changing opaque rows', async () => {
  const metadata = (await migrations()).find(m=>m.sql.includes('-- normalize-bank-account-column'));
  assert.ok(metadata);
  for (const upgraded of [false,true]) {
    const db = new Database(':memory:');
    try {
      db.exec(`CREATE TABLE user(id TEXT PRIMARY KEY); INSERT INTO user VALUES('owner');
        CREATE TABLE bank_item(item_id TEXT PRIMARY KEY,user_id TEXT,encrypted_access_token TEXT);
        CREATE TABLE bank_account(id TEXT PRIMARY KEY, archived_account_id TEXT, item_id TEXT, encrypted_data TEXT);
        CREATE TABLE archived_settings(user_id TEXT, encrypted_data TEXT);
        CREATE TABLE extra_settings(id TEXT, payload BLOB);
        CREATE TABLE app_migration(name TEXT PRIMARY KEY);
        INSERT INTO bank_item VALUES('saved','owner','opaque-token');
        INSERT INTO bank_account VALUES('stable-id','external-id','saved','opaque-account');
        INSERT INTO archived_settings VALUES('owner','opaque-settings');
        INSERT INTO extra_settings VALUES('fixture',X'00FF');`);
      if (upgraded) {
        applySqlMigration(db,metadata.sql);
        db.prepare('INSERT INTO app_migration VALUES(?)').run('0010_imported_bank_accounts.sql');
        db.exec("UPDATE bank_item SET provider='imported',provider_application_id='preserved'; INSERT INTO bank_connect_nonce VALUES('hash','owner','session','application','sandbox',123)");
      }
      const beforeSettings = db.prepare('SELECT * FROM archived_settings').all();
      const beforeExtra = db.prepare('SELECT * FROM extra_settings').all();
      applySqlMigration(db,metadata.sql);
      applySqlMigration(db,metadata.sql);
      assert.equal(db.prepare('SELECT encrypted_access_token FROM bank_item').get().encrypted_access_token,'opaque-token');
      assert.deepEqual(db.prepare('SELECT * FROM bank_account').get(),{id:'stable-id',provider_account_id:'external-id',item_id:'saved',encrypted_data:'opaque-account'});
      assert.deepEqual(db.prepare('SELECT * FROM archived_settings').all(),beforeSettings);
      assert.deepEqual(db.prepare('SELECT * FROM extra_settings').all(),beforeExtra);
      assert.equal(db.prepare('SELECT provider FROM bank_item').get().provider,upgraded?'imported':'legacy');
      if (upgraded) {
        assert.equal(db.prepare('SELECT provider_application_id FROM bank_item').get().provider_application_id,'preserved');
        assert.equal(db.prepare('SELECT count(*) n FROM bank_connect_nonce').get().n,1);
        assert.equal(db.prepare('SELECT count(*) n FROM app_migration').get().n,1);
      }
    } finally {db.close();}
  }
});

test('production server returns JSON 404 for removed settings and unknown API paths instead of the SPA', async () => {
  const { spawn } = await import('node:child_process');
  const { once } = await import('node:events');
  const { createServer } = await import('node:net');
  const { setTimeout: pause } = await import('node:timers/promises');
  const temp = await mkdtemp(join(process.env.TMPDIR || tmpdir(),'bank-server-'));
  const reservation = createServer();
  reservation.listen(0,'127.0.0.1');
  await once(reservation,'listening');
  const port = reservation.address().port;
  await new Promise(resolve=>reservation.close(resolve));
  const child = spawn(process.execPath,['--import','tsx','server/index.ts'],{env:{...process.env,DATABASE_PATH:join(temp,'fixture.sqlite'),PORT:String(port),ORIGIN_URL:'http://localhost:5173',BETTER_AUTH_SECRET:'isolated-bank-server-secret-at-least-32-characters'},stdio:['ignore','pipe','pipe']});
  let output = '';
  child.stdout.on('data',chunk=>{output+=chunk;});
  child.stderr.on('data',chunk=>{output+=chunk;});
  const base = 'http://127.0.0.1:'+port;
  try {
    let ready = false;
    for (let attempt=0;attempt<150;attempt++) {
      if (child.exitCode !== null) break;
      try {if ((await fetch(base+'/api/health')).ok) {ready=true;break;}} catch {}
      await pause(40);
    }
    assert.ok(ready,output);
    for (const path of ['/api/settings/retired','/api/settings','/api/missing']) {
      for (const method of ['GET','POST','PUT','PATCH','DELETE']) {
        const response = await fetch(base+path,{method});
        assert.equal(response.status,404,method+' '+path);
        assert.deepEqual(await response.json(),{error:'API endpoint not found.'});
      }
    }
    assert.equal((await fetch(base+'/api/accounts/items')).status,401);
  } finally {
    if (child.exitCode === null) {child.kill();await once(child,'exit');}
    await rm(temp,{recursive:true,force:true});
  }
});

test('exported production router preserves prefix handling and upgraded migration ledgers without touching saved rows', async () => {
  const temp = await mkdtemp(join(process.env.TMPDIR || tmpdir(),'bank-mount-'));
  const previous = {DATABASE_PATH:process.env.DATABASE_PATH,BETTER_AUTH_SECRET:process.env.BETTER_AUTH_SECRET,ORIGIN_URL:process.env.ORIGIN_URL};
  process.env.DATABASE_PATH = join(temp,'fixture.sqlite');
  process.env.BETTER_AUTH_SECRET = 'isolated-bank-mount-secret-at-least-32-characters';
  process.env.ORIGIN_URL = 'http://localhost:5173';
  const {runMigrations,sqliteClient:db,closeDatabase} = await import('../server/database.ts');
  const {auth} = await import('../server/auth.ts');
  const original = auth.api.getSession;
  try {
    await runMigrations();
    const {getBankEncryptionKey} = await import('../server/bank-crypto.ts');
    const enc = value=>encryptBankValue(value,getBankEncryptionKey());
    db.exec("INSERT INTO user(id,name,email) VALUES('owner','Fixture','mount@example.test'); CREATE TABLE archived_settings(user_id TEXT,encrypted_data TEXT); INSERT INTO archived_settings VALUES('owner','opaque-settings')");
    db.prepare('INSERT INTO bank_item(item_id,user_id,provider,encrypted_institution_name,encrypted_access_token) VALUES(?,?,?,?,?)').run('saved','owner','imported',enc('Fixture Bank'),'opaque-token');
    db.prepare('INSERT INTO bank_account(id,item_id,user_id,provider_account_id,encrypted_data) VALUES(?,?,?,?,?)').run('stable-id','saved','owner','external-id',enc(JSON.stringify({name:'Saved account'})));
    const metadata = (await migrations()).find(m=>m.sql.includes('-- normalize-bank-account-column'));
    assert.equal(metadata.name,'0010_bank_metadata.sql');
    db.prepare('DELETE FROM app_migration WHERE name=?').run(metadata.name);
    db.prepare('INSERT INTO app_migration(name) VALUES(?)').run('0010_imported_bank_accounts.sql');
    const before = db.prepare('SELECT * FROM bank_item').all();
    const beforeAccounts = db.prepare('SELECT * FROM bank_account').all();
    await runMigrations();
    await runMigrations();
    assert.deepEqual(db.prepare('SELECT * FROM bank_item').all(),before);
    assert.deepEqual(db.prepare('SELECT * FROM bank_account').all(),beforeAccounts);
    assert.deepEqual(db.prepare('SELECT * FROM archived_settings').all(),[{user_id:'owner',encrypted_data:'opaque-settings'}]);
    for (const name of [metadata.name,'0010_imported_bank_accounts.sql']) assert.ok(db.prepare('SELECT 1 FROM app_migration WHERE name=?').get(name));
    let user = 'owner';
    auth.api.getSession = async()=>user?{user:{id:user}}:null;
    const {bankAccountsRouter} = await import('../server/bank_accounts.ts');
    const app = new Hono().route('/api/accounts',bankAccountsRouter);
    for (const path of ['/api/accounts','/api/accounts/']) {
      const response = await app.request(path);
      assert.equal(response.status,200,path);
      assert.equal(response.headers.get('cache-control'),'no-store');
      assert.deepEqual((await response.json()).accounts.map(a=>a.id),['stable-id']);
    }
    for (const path of readPaths.slice(1)) assert.equal((await app.request('/api/accounts'+path)).status,200,path);
    assert.deepEqual(await (await app.request('/api/accounts/items/saved',{method:'DELETE'})).json(),{error:'API endpoint not found.'});
    user = null;
    for (const path of [...readPaths,...removedPaths]) {
      for (const method of ['GET','POST','DELETE']) assert.equal((await app.request('/api/accounts'+path,{method})).status,401,method+' '+path);
    }
    assert.deepEqual(db.prepare('SELECT * FROM bank_item').all(),before);
    assert.deepEqual(db.prepare('SELECT * FROM bank_account').all(),beforeAccounts);
  } finally {
    auth.api.getSession = original;
    await closeDatabase();
    for (const [name,value] of Object.entries(previous)) {if (value === undefined) delete process.env[name];else process.env[name]=value;}
    await rm(temp,{recursive:true,force:true});
  }
});

test('bank reads and unsupported mutations make zero external requests and leave every stored byte intact', async t => {
  const http = (await import('node:http')).default;
  const https = (await import('node:https')).default;
  const {syncBuiltinESMExports} = await import('node:module');
  let calls = 0;
  const forbidden = ()=>{calls++;throw Error('External requests are forbidden.');};
  const f = await fixture();
  try {
    t.mock.method(globalThis,'fetch',forbidden);
    for (const module of [http,https]) for (const method of ['get','request']) t.mock.method(module,method,forbidden);
    syncBuiltinESMExports();
    const before = f.db.serialize();
    for (const path of readPaths) assert.equal((await f.router.request(path)).status,200,path);
    for (const path of removedPaths) for (const method of ['POST','DELETE','PUT']) assert.equal((await f.router.request(path,{method})).status,404);
    assert.equal(calls,0);
    assert.deepEqual(f.db.serialize(),before);
  } finally {t.mock.restoreAll();syncBuiltinESMExports();f.db.close();}
});

test('corrupt cached ciphertext and authentication failures return generic errors without rewriting data', async () => {
  const f = await fixture();
  try {
    f.db.prepare('UPDATE bank_account SET encrypted_data=? WHERE id=?').run('private-corrupt-snapshot','stable-id');
    const before = f.db.serialize();
    for (const path of readPaths) {
      const response = await f.router.request(path);
      assert.equal(response.status,500,path);
      assert.equal(response.headers.get('cache-control'),'no-store');
      assert.deepEqual(await response.json(),{error:'Unable to read saved bank data.'});
    }
    const failing = createBankAccountsRouter({database:f.db,getUserId:async()=>{throw Error('private-session-error');},getEncryptionKey:()=>key});
    assert.deepEqual(await (await failing.request('/')).json(),{error:'Unable to read saved bank data.'});
    assert.deepEqual(f.db.serialize(),before);
  } finally {f.db.close();}
});

const readPaths = ['/', '/items', '/transactions', '/transactions/all', '/stable-id/transactions'];
const removedPaths = ['/connect-config', '/enroll', '/transactions/sync', '/items/saved/transactions/sync', '/items/saved', '/unknown'];
const migrationsDirectory = new URL('../server/migrations/', import.meta.url);
const key = Buffer.alloc(32, 7);
async function migrations() {
  return Promise.all((await readdir(migrationsDirectory)).filter(n => n.endsWith('.sql')).sort().map(async name => ({name, sql: await readFile(new URL(name, migrationsDirectory), 'utf8')})));
}
async function fixture() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys=ON');
  for (const {sql} of await migrations()) applySqlMigration(db, sql);
  for (const id of ['owner', 'other']) db.prepare('INSERT INTO user(id,name,email) VALUES(?,?,?)').run(id,id,id+'@example.test');
  const enc = value => encryptBankValue(typeof value === 'string' ? value : JSON.stringify(value), key);
  const item = (id, owner = 'owner', provider = 'imported') => db.prepare('INSERT INTO bank_item(item_id,user_id,provider,encrypted_institution_name,encrypted_access_token,updated_at) VALUES(?,?,?,?,?,?)').run(id,owner,provider,provider === 'legacy' ? 'opaque-institution' : enc(id+' Bank'),'opaque-token',1000);
  const account = (id, itemId, owner = 'owner', active = 1) => db.prepare('INSERT INTO bank_account(id,item_id,user_id,provider_account_id,encrypted_data,is_active,updated_at) VALUES(?,?,?,?,?,?,?)').run(id,itemId,owner,'external-'+id,itemId === 'legacy' ? 'opaque-account' : enc({name:id,currentBalance:123.45,id:'untrusted-payload-id'}),active,2000);
  const transaction = (id, itemId, accountId, owner = 'owner', date = '2026-11-01') => db.prepare('INSERT INTO bank_transaction(transaction_id,item_id,user_id,account_id,encrypted_data) VALUES(?,?,?,?,?)').run(id,itemId,owner,'external-'+accountId,itemId === 'legacy' ? 'opaque-transaction' : enc({transaction_id:id,account_id:'external-'+accountId,date,amount:12.5}));
  item('saved'); item('empty'); item('foreign','other'); item('legacy','owner','legacy');
  account('stable-id','saved'); account('inactive','saved','owner',0); account('foreign-id','foreign','other'); account('old-id','legacy');
  transaction('saved-tx','saved','stable-id'); transaction('foreign-tx','foreign','foreign-id','other'); transaction('old-tx','legacy','old-id');
  let userId = 'owner';
  const router = createBankAccountsRouter({database:db,getUserId:async()=>userId,getEncryptionKey:()=>key});
  return {db,router,setUser:value=>{userId=value;},transaction};
}

test('cached accounts and institutions remain visible without configuration and keep stable internal IDs', async () => {
  const f = await fixture();
  try {
    const response = await f.router.request('/');
    assert.equal(response.status,200);
    assert.equal(response.headers.get('cache-control'),'no-store');
    const data = await response.json();
    assert.equal(data.configured,false);
    assert.deepEqual(data.accounts.map(a=>a.id),['stable-id']);
    assert.equal(data.accounts[0].providerAccountId,'external-stable-id');
    assert.equal(data.accounts[0].institutionName,'saved Bank');
    assert.equal(data.accounts[0].currentBalance,123.45);
    assert.equal(data.accounts[0].updatedAt,new Date(2000*1000).toISOString());
    assert.equal(data.accounts[0].lastRetrievedAt,new Date(1000*1000).toISOString());
    assert.equal((await (await f.router.request('/')).json()).accounts[0].id,'stable-id');
    const items = await (await f.router.request('/items')).json();
    assert.equal(items.configured,false);
    assert.deepEqual(items.connections.map(i=>[i.itemId,i.accountCount]),[['saved',1],['empty',0]]);
    assert.deepEqual(items.connections[1].accounts,[]);
  } finally {f.db.close();}
});
