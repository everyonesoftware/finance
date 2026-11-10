import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const scratch = await mkdtemp(join(process.env.TMPDIR || tmpdir(), 'teller-settings-'));
process.env.DATABASE_PATH = join(scratch, 'settings.sqlite');
process.env.BETTER_AUTH_SECRET = 'isolated-settings-test-secret-at-least-32-characters';
process.env.ORIGIN_URL = 'http://localhost:5173';

// tsx resolves production .js imports back to their TypeScript sources.
const { register } = await import('tsx/esm/api');
register();

test('bank crypto uses stable purpose-separated encryption and authenticated envelopes', async () => {
  const crypto = await import('../server/bank-crypto.ts');
  const key = crypto.getBankEncryptionKey();
  assert.equal(key.length, 32);
  assert.deepEqual(key, crypto.getBankEncryptionKey());
  const encrypted = crypto.encryptBankValue('private fixture', key);
  assert.match(encrypted, /^v1\./);
  assert.equal(crypto.decryptBankValue(encrypted, key), 'private fixture');
  assert.notEqual(crypto.encryptBankValue('private fixture', key), encrypted);
  assert.throws(() => crypto.decryptBankValue('v2.a.b.c', key), crypto.UnsupportedBankDataFormatError);
  assert.throws(() => crypto.decryptBankValue('v1.@@@@.bad.bad', key), crypto.UnsupportedBankDataFormatError);
  assert.throws(() => crypto.decryptBankValue(encrypted, Buffer.alloc(32)), error => !(error instanceof crypto.UnsupportedBankDataFormatError));
  const previous = process.env.BETTER_AUTH_SECRET;
  process.env.BETTER_AUTH_SECRET += '-other';
  assert.notDeepEqual(crypto.getBankEncryptionKey(), key);
  process.env.BETTER_AUTH_SECRET = previous;
});

test('settings persist encrypted and scoped to the owning user with a public redacted shape', async () => {
  const { runMigrations, sqliteClient } = await import('../server/database.ts');
  const { getTellerSettings, getPublicTellerSettings, saveTellerSettings } = await import('../server/teller-settings.ts');
  await runMigrations();
  for (const id of ['owner', 'other']) sqliteClient.prepare('INSERT INTO user(id,name,email) VALUES(?,?,?)').run(id,id,id+'@example.test');
  assert.equal(getTellerSettings('owner'), null);
  assert.deepEqual(getPublicTellerSettings('owner'), { applicationId:'', environment:'sandbox', hasCertificate:false, hasPrivateKey:false, signingKey:'', configured:false });
  saveTellerSettings('owner', {applicationId:'app_fixture', environment:'sandbox'});
  assert.equal(getPublicTellerSettings('owner').configured, true);
  assert.equal(getTellerSettings('owner').applicationId, 'app_fixture');
  assert.equal(getTellerSettings('other'), null);
  const row = sqliteClient.prepare('SELECT encrypted_data FROM teller_settings WHERE user_id=?').get('owner');
  assert.match(row.encrypted_data, /^v1\./);
  assert.ok(!row.encrypted_data.includes('app_fixture'));
  sqliteClient.prepare('INSERT INTO user(id,name,email) VALUES(?,?,?)').run('deleted','Deleted','deleted@example.test');
  saveTellerSettings('deleted', {applicationId:'app_deleted',environment:'sandbox'});
  sqliteClient.prepare('DELETE FROM user WHERE id=?').run('deleted');
  assert.equal(sqliteClient.prepare('SELECT 1 FROM teller_settings WHERE user_id=?').get('deleted'), undefined);
});

test('validates inputs and live credentials, preserves blanks and supports explicit clearing', async () => {
  const { execFileSync } = await import('node:child_process');
  const { generateKeyPairSync } = await import('node:crypto');
  const { saveTellerSettings, getTellerSettings, getPublicTellerSettings } = await import('../server/teller-settings.ts');
  const certPath = join(scratch, 'cert.pem'), keyPath = join(scratch, 'key.pem');
  execFileSync('openssl', ['req','-x509','-newkey','rsa:2048','-nodes','-keyout',keyPath,'-out',certPath,'-subj','/CN=fixture','-days','1'], {stdio:'ignore'});
  const certificate = await readFile(certPath,'utf8'), privateKey = await readFile(keyPath,'utf8');
  const { publicKey, privateKey: signingPrivate } = generateKeyPairSync('ed25519');
  const pem = publicKey.export({format:'pem',type:'spki'}).toString();
  const raw = publicKey.export({format:'der',type:'spki'}).subarray(-32);
  const live = {applicationId:'app_live',environment:'development',certificate,privateKey,signingKey:pem};
  for (const input of [null, [], 'bad', {}, {applicationId:23}, {applicationId:' '}, {applicationId:'a',environment:'bad'}, {applicationId:'a',environment:'production'}, {...live, certificate:'secret-bad-certificate'}, {...live,privateKey:signingPrivate.export({format:'pem',type:'pkcs8'}).toString()}, {...live, signingKey:'bad'}, {...live,signingKey:certificate}, {...live,signingKey:signingPrivate.export({format:'pem',type:'pkcs8'}).toString()}, {...live,clearCredentials:'true'}]) {
    assert.throws(() => saveTellerSettings('owner',input));
  }
  saveTellerSettings('owner', live);
  assert.equal(getPublicTellerSettings('owner').configured,true);
  const exposed = JSON.stringify(getPublicTellerSettings('owner'));
  assert.ok(!exposed.includes('BEGIN CERTIFICATE'));
  assert.ok(!exposed.includes('PRIVATE KEY'));
  saveTellerSettings('owner',{applicationId:'app_new',environment:'production',certificate:' ',privateKey:'',signingKey:raw.toString('hex')});
  assert.equal(getTellerSettings('owner').certificate,certificate.trim());
  assert.equal(getTellerSettings('owner').privateKey,privateKey.trim());
  saveTellerSettings('owner',{signingKey:raw.toString('base64')});
  assert.equal(getTellerSettings('owner').signingKey,raw.toString('base64'));
  const before = getTellerSettings('owner');
  assert.throws(() => saveTellerSettings('owner',{certificate:'sensitive invalid certificate'}));
  assert.deepEqual(getTellerSettings('owner'),before);
  saveTellerSettings('owner',{clearCredentials:true});
  assert.equal(getTellerSettings('owner').certificate,null);
  assert.equal(getTellerSettings('owner').privateKey,null);
  assert.equal(getPublicTellerSettings('owner').configured,false);
});

test('settings routes authenticate, enforce trusted origins, bound streamed bodies and redact failures', async () => {
  const { settingsRouter } = await import('../server/settings.ts');
  const { auth } = await import('../server/auth.ts');
  const { getTellerSettings } = await import('../server/teller-settings.ts');
  const { Hono } = await import('hono');
  const app = new Hono().route('/api/settings',settingsRouter);
  const original = auth.api.getSession;
  let userId = null;
  auth.api.getSession = async () => userId ? {user:{id:userId}} : null;
  const request = (method='GET',body,origin='http://localhost:5173',extra={}) => app.request('/api/settings/teller',{method,headers:{'Content-Type':'application/json',...(origin?{Origin:origin}:{}),...extra},...(body===undefined?{}:{body:typeof body==='string'?body:JSON.stringify(body)})});
  try {
    for (const method of ['GET','PUT']) {
      const result = await request(method,method==='PUT'?{}:undefined);
      assert.equal(result.status,401);
      assert.equal(result.headers.get('cache-control'),'no-store');
    }
    userId = 'other';
    for (const origin of [null,'https://evil.example','http://localhost:5173.attacker.example','null','http://localhost:5173/path']) assert.equal((await request('PUT',{applicationId:'app_other'},origin)).status,403);
    assert.equal((await request('PUT','{')).status,400);
    assert.equal((await request('PUT',{certificate:'do-not-echo-this-secret'})).status,400);
    const saved = await request('PUT',{applicationId:'app_other',environment:'sandbox'});
    assert.equal(saved.status,200);
    assert.equal(saved.headers.get('cache-control'),'no-store');
    assert.deepEqual(await saved.json(),{applicationId:'app_other',environment:'sandbox',hasCertificate:false,hasPrivateKey:false,signingKey:'',configured:true});
    assert.equal((await (await request()).json()).applicationId,'app_other');
    assert.equal(getTellerSettings('owner').applicationId,'app_new');
    assert.equal((await request('PUT','x',null,{'Content-Length':'131073'})).status,403);
    assert.equal((await request('PUT','x','http://localhost:5173',{'Content-Length':'131073'})).status,413);
    let cancelled = false;
    const stream = new ReadableStream({pull(controller){controller.enqueue(new Uint8Array(8192));},cancel(){cancelled=true;}});
    const oversized = await app.request('/api/settings/teller',{method:'PUT',headers:{Origin:'http://localhost:5173','Content-Type':'application/json','Content-Length':'1'},body:stream,duplex:'half'});
    assert.equal(oversized.status,413);
    assert.equal(cancelled,true);
    assert.equal(getTellerSettings('other').applicationId,'app_other');
    const failure = await request('PUT',{privateKey:'do-not-echo-this-secret'});
    assert.equal(failure.status,400);
    assert.ok(!(await failure.text()).includes('do-not-echo-this-secret'));
    auth.api.getSession = async () => {throw Error('secret-internal-failure');};
    const internal = await request();
    assert.equal(internal.status,500);
    assert.ok(!(await internal.text()).includes('secret-internal-failure'));
  } finally {auth.api.getSession = original;}
});

test.after(async () => {
  try { const { closeDatabase } = await import('../server/database.ts'); await closeDatabase(); } catch {}
  await rm(scratch, { recursive: true, force: true });
});
