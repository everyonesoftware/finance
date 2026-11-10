import test from 'node:test';

test('official Teller ATM debit remains positive at storage boundary and displays as spending',async()=>{
 const {fetchTellerTransactions}=await import('../server/teller.ts');const {formatTransactionAmount}=await import('../src/account-transaction-utils.ts');
 const fixture={running_balance:null,details:{category:'service',counterparty:{type:'organization',name:'CARDTRONICS'}},description:'ATM Withdrawal',id:'txn_oiluj93igokseo0i3a005',date:'2023-07-13',account_id:'acc_oiin624kqjrg2mp2ea000',amount:'42.47',type:'atm',status:'posted'};
 const s={applicationId:'app_fixture',environment:'sandbox',certificate:null,privateKey:null,signingKey:null};
 const tx=await fetchTellerTransactions(s,'test_fixture',{id:fixture.account_id,snapshot:{currencyCode:'USD'}},async()=>[fixture,{...fixture,id:'txn_income',description:'Income fixture',amount:'-100.00',type:'ach'}]);
 assert.equal(tx[0].amount,42.47);assert.equal(formatTransactionAmount(tx[0].amount,'USD'),'-$42.47');
 assert.equal(tx[1].amount,-100);assert.equal(formatTransactionAmount(tx[1].amount,'USD'),'$100.00');
});


test('transaction pagination rejects cycles, foreign accounts and the page safety cap',async()=>{
 const {fetchTellerTransactions}=await import('../server/teller.ts');const s={applicationId:'app_fixture',environment:'sandbox',certificate:null,privateKey:null,signingKey:null},a={id:'acc_fixture',snapshot:{currencyCode:'USD'}};
 const make=(i,account='acc_fixture')=>({id:'txn_'+i,account_id:account,amount:'-2.5',date:'2026-11-01',description:'Isolated fixture',status:'posted'});
 let calls=0;await assert.rejects(fetchTellerTransactions(s,'test_fixture',a,async()=>{calls++;return Array.from({length:500},(_,i)=>make(i));}),/pagination/);assert.equal(calls,2);
 await assert.rejects(fetchTellerTransactions(s,'test_fixture',a,async()=>[make(1,'acc_someone_else')]),/ownership/);
 calls=0;await assert.rejects(fetchTellerTransactions(s,'test_fixture',a,async()=>{const p=calls++;return Array.from({length:500},(_,i)=>make(p*500+i));}),/page limit/);assert.equal(calls,100);
});
test('enrollment rejects foreign enrollment and balance identifiers before persisting',async()=>{
 const {createBankAccountsRouter}=await import('../server/bank_accounts.ts');const db=await fixtureDatabase();let wrongEnrollment=true,calls=0;
 const settings={applicationId:'app_fixture',environment:'sandbox',certificate:null,privateKey:null,signingKey:null};
 const transport=async(s,t,m,p)=>{calls++;if(p==='/accounts')return [{id:'acc_fixture',enrollment_id:wrongEnrollment?'enr_other':'enr_fixture',name:'Fixture',type:'depository',subtype:'checking',currency:'USD',last_four:'1234',status:'open',institution:{id:'fixture',name:'Fixture Bank'}}];return {account_id:'acc_other',ledger:'10',available:'9'};};
 const router=createBankAccountsRouter({database:db,getUserId:async()=> 'owner',getSettings:()=>settings,getEncryptionKey:()=>Buffer.alloc(32),transport});
 const req=(p,b)=>router.request(p,{method:'POST',headers:{origin:'http://localhost:5173','content-type':'application/json'},...(b?{body:JSON.stringify(b)}:{})});
 for(const wrong of [true,false]) {wrongEnrollment=wrong;const config=await (await req('/connect-config')).json();const e={nonce:config.nonce,accessToken:'test_fixture',user:{id:'usr_fixture'},enrollment:{id:'enr_fixture',institution:{name:'Fixture'}},signatures:[]};assert.equal((await req('/enroll',e)).status,400);assert.equal(db.prepare('SELECT COUNT(*) n FROM bank_item').get().n,0);}
 assert.equal(calls,3);db.close();
});


test('enrollment rejects oversized streamed bodies without buffering the rest',async()=>{
 const {createBankAccountsRouter}=await import('../server/bank_accounts.ts');const db=await fixtureDatabase();let pulls=0,cancelled=false;
 const router=createBankAccountsRouter({database:db,getUserId:async()=> 'owner',getSettings:()=>({applicationId:'app_fixture',environment:'sandbox',certificate:null,privateKey:null,signingKey:null}),getEncryptionKey:()=>Buffer.alloc(32)});
 const stream=new ReadableStream({pull(c){pulls++;c.enqueue(new Uint8Array(17000));if(pulls===10)c.close();},cancel(){cancelled=true;}});
 const response=await router.request('/enroll',{method:'POST',headers:{Origin:'http://localhost:5173'},body:stream,duplex:'half'});
 assert.equal(response.status,413);assert.equal(cancelled,true);assert.ok(pulls<=2);db.close();
});


test('native HTTPS fixes host and TLS, uses mTLS and Basic auth, rejects redirects and oversized responses',async()=>{
 const {createTellerTransport}=await import('../server/teller.ts');const {EventEmitter}=await import('node:events');
 const settings={applicationId:'app_fixture',environment:'production',certificate:'fixture-cert',privateKey:'fixture-key',signingKey:'fixture-signing-key'};
 let options,mode='success',calls=0;
 const request=(input,callback)=>{
  calls++;options=input;const req=new EventEmitter();req.destroy=error=>{req.emit('error',error);req.emit('close');};req.end=()=>queueMicrotask(()=>{
   const res=new EventEmitter();res.statusCode=mode==='redirect'?302:200;res.destroy=()=>res.emit('aborted');callback(res);
   if(mode==='oversized') res.emit('data',Buffer.alloc(8*1024*1024+1));
   else if(mode==='truncated') res.emit('aborted');
   else if(mode==='error') res.emit('error',Error('secret-fixture-token'));
   else {res.emit('data',Buffer.from('[{"id":"fixture"}]'));res.emit('end');}
   req.emit('close');
  });return req;
 };
 const transport=createTellerTransport(request);assert.deepEqual(await transport(settings,'fixture_token','GET','/accounts'),[{id:'fixture'}]);
 assert.equal(options.hostname,'api.teller.io');assert.equal(options.port,443);assert.equal(options.rejectUnauthorized,true);assert.equal(options.minVersion,'TLSv1.2');assert.equal(options.agent,false);assert.equal(options.cert,'fixture-cert');assert.equal(options.key,'fixture-key');assert.equal(options.headers.Authorization,'Basic '+Buffer.from('fixture_token:').toString('base64'));
 const before=calls;await assert.rejects(transport(settings,'fixture_token','GET','https://attacker.example/accounts'));assert.equal(calls,before);
 await assert.rejects(transport({...settings,certificate:null},'fixture_token','GET','/accounts'));assert.equal(calls,before);
 for(const m of ['redirect','oversized','truncated','error']) {mode=m;await assert.rejects(transport(settings,'fixture_token','GET','/accounts'),e=>!e.message.includes('secret-fixture-token'));}
 assert.equal(calls,before+4);
});
test('native HTTPS enforces a total timeout even with no response',async(t)=>{
 const {createTellerTransport}=await import('../server/teller.ts');const {EventEmitter}=await import('node:events');t.mock.timers.enable({apis:['setTimeout']});let destroyed=false;
 const transport=createTellerTransport(()=>{const req=new EventEmitter();req.end=()=>{};req.destroy=e=>{destroyed=true;req.emit('error',e);req.emit('close');};return req;});
 const promise=transport({applicationId:'app_fixture',environment:'sandbox',certificate:null,privateKey:null,signingKey:null},'test_fixture','GET','/accounts');
 t.mock.timers.tick(15000);await assert.rejects(promise,/transport failed/);assert.equal(destroyed,true);
});


test('exported router works under the production accounts mount',async()=>{
 const {mkdtemp,rm}=await import('node:fs/promises');const {join}=await import('node:path');const {Hono}=await import('hono');
 const {tmpdir}=await import('node:os');
 const temp=await mkdtemp(join(process.env.TMPDIR || tmpdir(),'teller-mount-test-'));
 process.env.ORIGIN_URL='http://localhost:5173';process.env.DATABASE_PATH=join(temp,'fixture.sqlite');process.env.BETTER_AUTH_SECRET='isolated-teller-mount-fixture-secret-32-chars';
 const {runMigrations,sqliteClient,closeDatabase}=await import('../server/database.ts');await runMigrations();
 const {auth}=await import('../server/auth.ts');const original=auth.api.getSession;
 try {
  sqliteClient.prepare('INSERT INTO user(id,name,email) VALUES(?,?,?)').run('mount-owner','Mount fixture','mount@example.test');
  const {saveTellerSettings}=await import('../server/teller-settings.ts');saveTellerSettings('mount-owner',{applicationId:'app_fixture',environment:'sandbox'});
  auth.api.getSession=async()=>({user:{id:'mount-owner'},session:{id:'fixture-session'}});
  const {bankAccountsRouter}=await import('../server/bank_accounts.ts');const app=new Hono().route('/api/accounts',bankAccountsRouter);
  const response=await app.request('/api/accounts/connect-config',{method:'POST',headers:{Origin:'http://localhost:5173'}});
  assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');const payload=await response.json();assert.equal(payload.applicationId,'app_fixture');assert.deepEqual(payload.products,['balance','transactions']);
  assert.equal((await app.request('/api/accounts/items')).status,200);
 } finally {auth.api.getSession=original;await closeDatabase();await rm(temp,{recursive:true,force:true});}
});


async function fixtureDatabase() {
 const db=new Database(':memory:');db.pragma('foreign_keys=ON');const {readdir}=await import('node:fs/promises');const dir=new URL('../server/migrations/',import.meta.url);
 for(const n of (await readdir(dir)).filter(n=>n.endsWith('.sql')).sort()) applySqlMigration(db,await readFile(new URL(n,dir),'utf8'));
 for(const u of ['owner','other']) db.prepare('INSERT INTO user(id,name,email) VALUES(?,?,?)').run(u,u,u+'@example.test');return db;
}
test('live signatures accept dashboard hex keys over the documented SHA256 digest',async()=>{
 const {generateKeyPairSync,sign,createHash}=await import('node:crypto');const {verifyEnrollmentSignature}=await import('../server/teller.ts');
 const {publicKey,privateKey}=generateKeyPairSync('ed25519');const keyBytes=publicKey.export({format:'der',type:'spki'}).subarray(-32);
 const e={nonce:'a'.repeat(64),accessToken:'live_fixture_token',user:{id:'usr_fixture'},enrollment:{id:'enr_fixture',institution:{name:'Fixture'}},signatures:[]};
 const settings={applicationId:'app_fixture',environment:'production',certificate:'fixture-only',privateKey:'fixture-only',signingKey:keyBytes.toString('hex')};
 const digest=createHash('sha256').update([e.nonce,e.accessToken,e.user.id,e.enrollment.id,settings.environment].join('.')).digest();
 e.signatures=[sign(null,digest,privateKey).toString('base64')];assert.equal(verifyEnrollmentSignature(e,settings),true);
 for(const mutated of [{...e,accessToken:'other'},{...e,nonce:'b'.repeat(64)},{...e,user:{id:'other'}},{...e,enrollment:{...e.enrollment,id:'other'}}]) assert.equal(verifyEnrollmentSignature(mutated,settings),false);
 assert.equal(verifyEnrollmentSignature(e,{...settings,environment:'development'}),false);
 assert.equal(verifyEnrollmentSignature({...e,signatures:[sign(null,Buffer.from([e.nonce,e.accessToken,e.user.id,e.enrollment.id,settings.environment].join('.')),privateKey).toString('base64')]},settings),false);
});
test('live nonce is user/session/config scoped, expiring, single-use and requires valid signatures',async()=>{
 const {createBankAccountsRouter}=await import('../server/bank_accounts.ts');const {generateKeyPairSync,sign,createHash}=await import('node:crypto');
 const db=await fixtureDatabase();const {publicKey,privateKey}=generateKeyPairSync('ed25519');
 let user='owner',session='session-a',clock=1000000,calls=0;
 const settings={applicationId:'app_fixture',environment:'production',certificate:'isolated-fixture',privateKey:'isolated-fixture',signingKey:publicKey.export({format:'pem',type:'spki'}).toString()};
 const router=createBankAccountsRouter({database:db,getUserId:async()=>user,getSessionBinding:()=>session,getSettings:()=>settings,getEncryptionKey:()=>Buffer.alloc(32,9),now:()=>clock,transport:async()=>{calls++;return [];}});
 const req=(p,method='POST',body)=>router.request(p,{method,headers:{origin:'http://localhost:5173','content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
 const config=async()=>await (await req('/connect-config')).json();
 const enrollment=n=>{const e={nonce:n,accessToken:'live_fixture_token',user:{id:'usr_fixture'},enrollment:{id:'enr_fixture',institution:{name:'Fixture Bank'}},signatures:[]};e.signatures=[sign(null,createHash('sha256').update([n,e.accessToken,e.user.id,e.enrollment.id,settings.environment].join('.')).digest(),privateKey).toString('base64')];return e;};
 const first=await config(),e=enrollment(first.nonce);session='session-b';assert.equal((await req('/enroll','POST',e)).status,400);session='session-a';
 user='other';assert.equal((await req('/enroll','POST',e)).status,400);user='owner';
 settings.applicationId='app_changed';assert.equal((await req('/enroll','POST',e)).status,400);settings.applicationId='app_fixture';
 assert.equal(calls,0);assert.equal((await req('/enroll','POST',e)).status,200);assert.equal(calls,1);assert.equal((await req('/enroll','POST',e)).status,400);
 const expired=enrollment((await config()).nonce);clock+=300001;assert.equal((await req('/enroll','POST',expired)).status,400);assert.equal(calls,1);
 const invalid=enrollment((await config()).nonce);invalid.signatures=['A'.repeat(88)];assert.equal((await req('/enroll','POST',invalid)).status,400);assert.equal((await req('/enroll','POST',enrollment(invalid.nonce))).status,400);assert.equal(calls,1);
 user='other';const replay=enrollment((await config()).nonce);assert.equal((await req('/enroll','POST',replay)).status,409);assert.equal(calls,1);
 user='owner';settings.environment='development';const changed=await req('/items/enr_fixture/transactions/sync');assert.equal(changed.status,409);assert.equal(calls,1);
 settings.environment='production';settings.certificate=null;settings.privateKey=null;const listed=await req('/items','GET');assert.equal(listed.status,200);const saved=await listed.json();assert.equal(saved.configured,false);assert.equal(saved.connections.length,1);assert.equal((await req('/items/enr_fixture/transactions/sync')).status,503);
 db.close();
});
test('native HTTPS transport has an injectable request seam',async()=>{
 const module=await import('../server/teller.ts');assert.equal(typeof module.createTellerTransport,'function');
});

import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { readFile } from 'node:fs/promises';
import { applySqlMigration } from '../server/migration-utils.ts';

test('bank routes expose an isolated injectable persistence boundary', async () => {
  const source = await readFile(new URL('../server/bank_accounts.ts', import.meta.url), 'utf8');
  assert.match(source, /export function createBankAccountsRouter/);
  const module = await import('../server/bank_accounts.ts');
  assert.equal(typeof module.createBankAccountsRouter, 'function');
});

test('upgrade discovers a non-neutral account column and preserves legacy rows', async () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE bank_item(item_id TEXT PRIMARY KEY, user_id TEXT, encrypted_access_token TEXT);
    CREATE TABLE bank_account(id TEXT PRIMARY KEY, previous_account_id TEXT, item_id TEXT, encrypted_data TEXT);
    INSERT INTO bank_item VALUES('old-item','owner','opaque-token');
    INSERT INTO bank_account VALUES('old-account','old-provider-id','old-item','opaque-data');`);
  const migration = await readFile(new URL('../server/migrations/0010_teller_bank_accounts.sql', import.meta.url), 'utf8').catch(() => '');
  applySqlMigration(db, migration);
  assert.ok(db.prepare('PRAGMA table_info(bank_account)').all().some(c => c.name === 'provider_account_id'));
  assert.deepEqual(db.prepare('SELECT provider, encrypted_access_token FROM bank_item').get(), {provider:'legacy',encrypted_access_token:'opaque-token'});
  assert.equal(db.prepare('SELECT provider_account_id, encrypted_data FROM bank_account').get().encrypted_data, 'opaque-data');
  db.close();
});

test('enrollment, full pagination, balances, failure preservation and ownership use real persistence', async () => {
 const { createBankAccountsRouter } = await import('../server/bank_accounts.ts');
 const db = new Database(':memory:'); db.pragma('foreign_keys=ON');
 const { readdir } = await import('node:fs/promises'); const dir = new URL('../server/migrations/', import.meta.url);
 for (const n of (await readdir(dir)).filter(n=>n.endsWith('.sql')).sort()) applySqlMigration(db,await readFile(new URL(n,dir),'utf8'));
 for(const u of ['owner','other']) db.prepare('INSERT INTO user(id,name,email) VALUES(?,?,?)').run(u,u,u+'@example.test');
 db.prepare('INSERT INTO bank_item(item_id,user_id,encrypted_institution_name,encrypted_access_token) VALUES(?,?,?,?)').run('legacy','owner','opaque','do-not-send');
 let userId='owner', fail=false, ledger='123.45', empty=false; const calls=[];
 const settings={applicationId:'app_fixture',environment:'sandbox',certificate:null,privateKey:null,signingKey:null};
 const transport=async (s,token,method,path)=>{
  calls.push({token,method,path}); assert.equal(token,'test_token_fixture');
  if(method==='DELETE') {if(fail) throw Error('fixture failure'); return null;}
  if(path==='/accounts') return [{id:'acc_fixture',enrollment_id:'enr_fixture',name:'Fixture Checking',type:'depository',subtype:'checking',currency:'USD',last_four:'1234',status:'open',institution:{id:'fixture',name:'Fixture Bank'}}];
  if(path.endsWith('/balances')) return {account_id:'acc_fixture',ledger,available:'100.00'};
  if(path.includes('from_id=')) {if(fail) throw Error('fixture page failure'); return [];}
  if(empty) return [];
  return Array.from({length:500},(_,i)=>({id:`txn_${i}`,account_id:'acc_fixture',date:'2026-11-01',amount:i===0?'-12.50':'25.00',description:'Fixture transaction',status:'posted'}));
 };
 const router=createBankAccountsRouter({database:db,getUserId:async()=>userId,getSettings:()=>settings,getEncryptionKey:()=>Buffer.alloc(32,7),transport});
 const req=(p,method='GET',body)=>router.request(p,{method,headers:{Origin:'http://localhost:5173','Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
 const config=await (await req('/connect-config','POST')).json(); assert.deepEqual(config.products,['balance','transactions']); assert.match(config.nonce,/^[a-f0-9]{64}$/);
 const enrollment={nonce:config.nonce,accessToken:'test_token_fixture',user:{id:'usr_fixture'},enrollment:{id:'enr_fixture',institution:{name:'Fixture Bank'}},signatures:[]};
 const enrolled=await req('/enroll','POST',enrollment); assert.equal(enrolled.status,200); const payload=await enrolled.json();
 assert.equal(payload.accounts[0].providerAccountId,'acc_fixture'); assert.equal(payload.accounts[0].currentBalance,123.45);
 assert.equal(db.prepare("SELECT provider FROM bank_item WHERE item_id='enr_fixture'").get().provider,'teller');
 assert.notEqual(db.prepare("SELECT encrypted_access_token FROM bank_item WHERE item_id='enr_fixture'").get().encrypted_access_token,enrollment.accessToken);
 assert.equal((await req('/enroll','POST',enrollment)).status,400);
 assert.equal((await req('/items/enr_fixture/transactions/sync','POST')).status,200);
 const tx=await (await req('/transactions/all')).json(); assert.equal(tx.transactions.length,500); assert.equal(tx.transactions[0].amount,-12.5); assert.ok(calls.some(c=>c.path.includes('from_id=txn_499')));
 const before=db.prepare("SELECT encrypted_data FROM bank_account WHERE item_id='enr_fixture'").get().encrypted_data;
 ledger='999.00'; fail=true; assert.equal((await req('/items/enr_fixture/transactions/sync','POST')).status,502);
 assert.equal(db.prepare("SELECT encrypted_data FROM bank_account WHERE item_id='enr_fixture'").get().encrypted_data,before); assert.equal(db.prepare('SELECT COUNT(*) n FROM bank_transaction').get().n,500);
 assert.equal((await req('/items/enr_fixture','DELETE')).status,502); assert.ok(db.prepare("SELECT 1 FROM bank_item WHERE item_id='enr_fixture'").get());
 userId='other'; const count=calls.length; assert.equal((await req('/items/enr_fixture/transactions/sync','POST')).status,404); assert.equal((await req('/items/enr_fixture','DELETE')).status,404); assert.equal(calls.length,count);
 userId='owner';fail=false;empty=true;assert.equal((await req('/items/enr_fixture/transactions/sync','POST')).status,200);assert.equal(db.prepare('SELECT COUNT(*) n FROM bank_transaction').get().n,0);const refreshed=await (await req('/')).json();assert.equal(refreshed.accounts[0].currentBalance,999);assert.equal(refreshed.accounts[0].id,payload.accounts[0].id);
 assert.equal((await req('/items/enr_fixture','DELETE')).status,204); assert.ok(db.prepare("SELECT * FROM bank_item WHERE item_id='legacy'").get());
 db.close();
});
