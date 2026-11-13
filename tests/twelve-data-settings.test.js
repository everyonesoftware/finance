import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { Hono } from 'hono';
import { applySqlMigration } from '../server-dist/migration-utils.js';
import { decryptBankValue } from '../server-dist/bank-crypto.js';

async function fixture(t) {
  // A missing feature is an assertion failure, not an unresolved static import.
  let module;
  try { module = await import('../server-dist/twelve-data-settings.js'); } catch {}
  assert.equal(typeof module?.createTwelveDataSettingsRouter, 'function', 'Twelve Data settings router exists');
  const db = new Database(':memory:');
  db.pragma('foreign_keys=ON');
  for (const name of readdirSync(new URL('../server/migrations/', import.meta.url)).filter(n => n.endsWith('.sql')).sort()) {
    applySqlMigration(db, readFileSync(new URL('../server/migrations/' + name, import.meta.url), 'utf8'));
  }
  t.after(() => db.close());
  for (const id of ['owner', 'other']) db.prepare('INSERT INTO user(id,name,email) VALUES(?,?,?)').run(id,id,id+'@example.test');
  const key = Buffer.alloc(32, 43);
  let user = 'owner', brokenKey = false;
  const app = new Hono();
  app.route('/api/settings/twelve-data', module.createTwelveDataSettingsRouter({ database: db, getUserId: async () => user, getEncryptionKey: () => { if (brokenKey) throw Error('sensitive details'); return key; }, trustedOrigins: ['https://finance.example'] }));
  const send = (method='GET', body, headers={}) => app.request('https://finance.example/api/settings/twelve-data', {
    method, headers: { 'content-type': 'application/json', origin: 'https://finance.example', ...headers },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
  return { db, key, send, setUser: id => { user=id; }, breakKey: () => { brokenKey=true; } };
}
const syntheticKey = 'synthetic-not-a-real-provider-key';

test('Twelve Data key is encrypted, replaceable, never echoed, and scoped to its owner', async t => {
  const f = await fixture(t);
  assert.deepEqual(await (await f.send()).json(), { configured:false });
  const saved = await f.send('PUT', { apiKey:syntheticKey });
  assert.equal(saved.status,200);
  assert.deepEqual(await saved.json(), { configured:true });
  const row = f.db.prepare('SELECT encrypted_api_key FROM twelve_data_settings WHERE user_id=?').get('owner');
  assert.equal(decryptBankValue(row.encrypted_api_key,f.key),syntheticKey);
  assert.ok(!f.db.serialize().includes(Buffer.from(syntheticKey)));
  const status = await f.send();
  assert.equal(status.headers.get('cache-control'),'no-store');
  assert.deepEqual(await status.json(), { configured:true });
  f.setUser('other');
  assert.deepEqual(await (await f.send()).json(), { configured:false });
  await f.send('PUT', { apiKey:'different-synthetic-key' });
  await f.send('DELETE', {});
  f.setUser('owner');
  assert.deepEqual(await (await f.send()).json(), { configured:true });
  await f.send('PUT', { apiKey:'replacement-synthetic-key' });
  assert.equal(decryptBankValue(f.db.prepare('SELECT encrypted_api_key FROM twelve_data_settings WHERE user_id=?').get('owner').encrypted_api_key,f.key),'replacement-synthetic-key');
  await f.send('DELETE', {});
  assert.deepEqual(await (await f.send()).json(), { configured:false });
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM twelve_data_settings').get().n,0);
});

test('Twelve Data settings require authentication for every operation', async t => {
  const f=await fixture(t); f.setUser(null);
  for (const [method,body] of [['GET',undefined],['PUT',{apiKey:syntheticKey}],['DELETE',{}]]) {
    const response=await f.send(method,body); assert.equal(response.status,401);
    assert.equal(response.headers.get('cache-control'),'no-store');
  }
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM twelve_data_settings').get().n,0);
});

test('Twelve Data settings reject cross-site writes, invalid payloads and oversized streamed bodies', async t => {
  const f=await fixture(t);
  await f.send('PUT',{apiKey:syntheticKey});
  for (const method of ['PUT','DELETE']) {
    assert.equal((await f.send(method,{apiKey:'other'},{origin:'https://evil.example'})).status,403);
    assert.equal((await f.send(method,{},{'sec-fetch-site':'cross-site'})).status,403);
    assert.equal((await f.send(method,{}, {'content-type':'text/plain'})).status,400);
    assert.equal((await f.send(method,'{')).status,400);
    assert.equal((await f.send(method,'x'.repeat(5000))).status,413);
  }
  for (const body of [{},{apiKey:''},{apiKey:'  '},{apiKey:null},{apiKey:3},{apiKey:'a b'},{apiKey:'abc\nsecret'},{apiKey:'abc\n'},{apiKey:'abc\r'},{apiKey:'abc\r\n'},{apiKey:'abc\u2028'},{apiKey:' key '},{apiKey:'x'.repeat(1025)},[],{apiKey:syntheticKey,userId:'other'}]) {
    assert.equal((await f.send('PUT',JSON.stringify(body))).status,400);
  }
  assert.deepEqual(await (await f.send()).json(),{configured:true});
  assert.equal(decryptBankValue(f.db.prepare('SELECT encrypted_api_key FROM twelve_data_settings WHERE user_id=?').get('owner').encrypted_api_key,f.key),syntheticKey);
});

test('Twelve Data storage errors use safe messages and preserve the prior key', async t => {
  const f=await fixture(t); await f.send('PUT',{apiKey:syntheticKey}); f.breakKey();
  const response=await f.send('PUT',{apiKey:'replacement'});
  assert.equal(response.status,500);
  const text=await response.text();
  assert.ok(!text.includes('sensitive details')&&!text.includes(syntheticKey)&&!text.includes('replacement'));
  assert.equal(decryptBankValue(f.db.prepare('SELECT encrypted_api_key FROM twelve_data_settings WHERE user_id=?').get('owner').encrypted_api_key,f.key),syntheticKey);
  f.db.prepare("DELETE FROM user WHERE id='owner'").run();
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM twelve_data_settings').get().n,0);
});

test('production Twelve Data mount handles prefixes and trusted HTTPS origins with a persistent encrypted key', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const dir = await mkdtemp(join(process.env.TMPDIR || tmpdir(), 'finance-twelve-data-mount-'));
  const names = ['DATABASE_PATH','BETTER_AUTH_SECRET','ORIGIN_URL'];
  const previous = Object.fromEntries(names.map(name => [name,process.env[name]]));
  process.env.DATABASE_PATH=join(dir,'fixture.sqlite');
  process.env.BETTER_AUTH_SECRET='synthetic-twelve-data-storage-secret-at-least-32';
  process.env.ORIGIN_URL='https://finance.example';
  let database, auth, original;
  try {
    database=await import('../server-dist/database.js');
    ({auth}=await import('../server-dist/auth.js'));
    original=auth.api.getSession;
    await database.runMigrations();
    await database.runMigrations();
    database.sqliteClient.prepare('INSERT INTO user(id,name,email) VALUES(?,?,?)').run('mount-owner','Synthetic','mount@example.test');
    let signedIn=true;
    auth.api.getSession=async()=>signedIn?{user:{id:'mount-owner'}}:null;
    const {twelveDataSettingsRouter}=await import('../server-dist/twelve-data-settings.js');
    const app=new Hono().route('/api/settings/twelve-data',twelveDataSettingsRouter);
    const endpoint='http://internal-proxy/api/settings/twelve-data';
    const save=await app.request(endpoint,{method:'PUT',headers:{origin:'https://finance.example','content-type':'application/json'},body:JSON.stringify({apiKey:syntheticKey})});
    assert.equal(save.status,200);
    for (const path of [endpoint,endpoint+'/']) assert.deepEqual(await (await app.request(path)).json(),{configured:true});
    const {getBankEncryptionKey}=await import('../server-dist/bank-crypto.js');
    assert.equal(decryptBankValue(database.sqliteClient.prepare('SELECT encrypted_api_key FROM twelve_data_settings').get().encrypted_api_key,getBankEncryptionKey()),syntheticKey);
    signedIn=false;
    assert.equal((await app.request(endpoint)).status,401);
  } finally {
    if(auth&&original) auth.api.getSession=original;
    if(database) await database.closeDatabase();
    for(const name of names) { if(previous[name]===undefined) delete process.env[name];else process.env[name]=previous[name]; }
    await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  }
});
