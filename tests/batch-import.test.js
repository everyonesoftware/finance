import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {readFileSync,readdirSync} from 'node:fs';
import {Hono} from 'hono';
import {createBankAccountsRouter} from '../server-dist/bank_accounts.js';
import {decryptBankValue} from '../server-dist/bank-crypto.js';

test('batch overlap counts match atomic import, repeat imports and existing single-file identities',async t=>{
 const {post,account,state,db,key}=fixture(t);const a=await account();
 const files=[{...ofx(),accountId:a.id},{...ofx(),fileName:'overlap.ofx',accountId:a.id},csv('rows.csv','2026-11-02,Shop,-7\n2026-11-02,Shop,-7',{accountId:a.id}),csv('overlap.csv','2026-11-02,Shop,-7',{accountId:a.id})];
 const before=state();
 let response=await post('/import-batch/preview',{files});assert.equal(response.status,200);
 assert.deepEqual((await response.json()).files.map(f=>[f.importable,f.duplicates]),[[1,0],[0,1],[2,0],[0,1]]);assert.deepEqual(state(),before);
 response=await post('/import-batch',{files});assert.equal(response.status,200);
 assert.deepEqual(await response.json(),{files:files.map((f,i)=>({fileName:f.fileName,accountId:a.id,imported:[1,0,2,0][i],skipped:[0,1,0,1][i]})),imported:3,skipped:2});
 const after=state();assert.deepEqual(after.accounts,before.accounts);assert.deepEqual(after.items,before.items);
 response=await post('/import-batch',{files});assert.equal(response.status,200);assert.equal((await response.json()).imported,0);assert.deepEqual(state(),after);
 for(const file of files){response=await post('/'+a.id+'/import',file);assert.equal(response.status,200);assert.equal((await response.json()).imported,0);}
 const single=csv('single.csv','2026-11-03,From single,-8',{accountId:a.id});assert.equal((await post('/'+a.id+'/import',single)).status,200);
 response=await post('/import-batch/preview',{files:[single]});assert.equal((await response.json()).files[0].duplicates,1);
 for(const row of db.prepare('SELECT * FROM bank_transaction').all()){
  assert.match(row.transaction_id,/^[a-f0-9]{64}$/);assert.doesNotMatch(row.encrypted_data,/source-one|Coffee|rows.csv/);
  const tx=JSON.parse(decryptBankValue(row.encrypted_data,key));assert.equal(tx.account_id,a.providerAccountId);assert.ok(tx.importFingerprint);
 }
});

test('changed source IDs mark every conflicting preview file and cannot write any part of a batch',async t=>{
 const {post,account,state}=fixture(t);const a=await account();
 const original={...ofx('private-id'),accountId:a.id},changed={...ofx('private-id','-6'),accountId:a.id},fresh=csv('fresh.csv',undefined,{accountId:a.id});
 const before=state();
 let response=await post('/import-batch/preview',{files:[original,changed,fresh]});assert.equal(response.status,200);
 let files=(await response.json()).files;
 assert.deepEqual(files.map(f=>f.status),['error','error','ready']);
 for(const f of files.slice(0,2)){assert.equal(f.importable,0);assert.match(f.errors.join(' '),/source.*conflict/i);assert.doesNotMatch(f.reason,/private-id/);}
 assert.deepEqual(state(),before);
 response=await post('/import-batch',{files:[fresh,original,changed]});assert.equal(response.status,409);assert.deepEqual(state(),before);
 assert.equal((await post('/'+a.id+'/import',original)).status,200);const saved=state();
 response=await post('/import-batch/preview',{files:[changed]});assert.equal(response.status,200);assert.equal((await response.json()).files[0].status,'error');
 response=await post('/import-batch',{files:[fresh,changed]});assert.equal(response.status,409);assert.deepEqual(state(),saved);
});

test('invalid destinations and invalid files reject the whole batch without changing snapshots',async t=>{
 const {post,account,state,db}=fixture(t);const a=await account();const other=await account({},'bob'),inactive=await account(),saved=await account();
 db.prepare('UPDATE bank_account SET is_active=0 WHERE id=?').run(inactive.id);db.prepare("UPDATE bank_item SET provider='imported' WHERE item_id=?").run(saved.itemId);
 const good=csv('good.csv',undefined,{accountId:a.id}),before=state();
 for(const id of [other.id,inactive.id,saved.id,'missing']) {
  const file=csv('bad-destination.csv',undefined,{accountId:id});
  const preview=await post('/import-batch/preview',{files:[file]});assert.equal(preview.status,200);const [f]=(await preview.json()).files;
  assert.equal(f.status,'error');assert.equal(f.importable,0);assert.ok(f.errors.length);
  const response=await post('/import-batch',{files:[good,file]});assert.equal(response.status,400);assert.deepEqual(state(),before);
 }
 for(const file of [csv('invalid.csv','2026-02-30,Bad,2',{accountId:a.id}),csv('unmapped.csv',undefined),ofx(),csv('wrong.csv',undefined,{accountId:a.id,csv:{dateColumn:-1}})]) {
  const response=await post('/import-batch',{files:[good,file]});assert.equal(response.status,400);assert.deepEqual(state(),before);
 }
 // A late SQLite failure must roll back an earlier file, not just validate first.
 db.exec("CREATE TRIGGER reject_test BEFORE INSERT ON bank_transaction WHEN (SELECT count(*) FROM bank_transaction)>0 BEGIN SELECT RAISE(ABORT,'test failure'); END");
 const response=await post('/import-batch',{files:[good,csv('second.csv','2026-11-02,Other,-9',{accountId:a.id})]});assert.equal(response.status,500);assert.deepEqual(state(),before);
});

test('batch limits are strict and the streaming reader is bounded without changing the single import limit',async t=>{
 const {post,account,app,state}=fixture(t);const a=await account();const before=state();
 for(const files of [[],Array.from({length:31},()=>csv()),[null],[{}],[csv('',undefined)],[{fileName:'a.csv',content:7}],[csv('a.csv',undefined,{accountId:7})]]) {
  assert.equal((await post('/import-batch/preview',{files})).status,400);
 }
 const big={fileName:'big.csv',content:'x'.repeat(4*1024*1024+1),accountId:a.id};
 assert.equal((await post('/import-batch/preview',{files:[big]})).status,413);
 const bytes={...big,content:'é'.repeat(2*1024*1024+1)};assert.equal((await post('/import-batch',{files:[bytes]})).status,413);
 const padded={...ofx(),accountId:a.id};padded.content=padded.content.replace('<OFX>','<OFX><!--'+'x'.repeat(3*1024*1024)+'-->');
 assert.equal((await post('/import-batch/preview',{files:[padded,padded]})).status,200,'Batch reader permits more than 5 MiB');
 assert.equal((await post('/'+a.id+'/import/preview',{...padded,content:' '.repeat(6*1024*1024)})).status,413);
 let pulls=0,cancelled=false;
 const stream=new ReadableStream({pull(c){pulls++;c.enqueue(new Uint8Array(1024*1024).fill(32));},cancel(){cancelled=true;}});
 const response=await app.request('http://localhost/api/accounts/import-batch/preview',{method:'POST',headers:{'content-type':'application/json','x-user':'alice'},body:stream,duplex:'half'});
 assert.equal(response.status,413);assert.equal(cancelled,true);assert.ok(pulls<=34);assert.deepEqual(state(),before);
});

test('batch authentication and same-origin protections apply to preview and import',async t=>{
 const {post,account,state}=fixture(t);const a=await account();const body={files:[csv('a.csv',undefined,{accountId:a.id})]},before=state();
 for(const path of ['/import-batch/preview','/import-batch']) {
  assert.equal((await post(path,body,'')).status,401);
  assert.equal((await post(path,body,'alice',{origin:'https://attacker.example.test'})).status,403);
  assert.equal((await post(path,body,'alice',{'sec-fetch-site':'cross-site'})).status,403);
  assert.equal((await post(path,body,'bob')).status,path.endsWith('preview')?200:400);
  assert.equal((await post(path,body,'alice',{'content-type':'text/plain'})).status,400);
 }
 assert.deepEqual(state(),before);
 assert.equal((await post('/import-batch/preview',body,'alice',{origin:'https://finance.example.test'})).status,200);
 assert.equal((await post('/import-batch',body,'alice',{origin:'https://finance.example.test'})).status,200);
});

test('explicit editable CSV mappings preserve account-scoped source identities and empty optional IDs',async t=>{
 const {post,account,db}=fixture(t);const a=await account(),b=await account();
 const mapping={dateColumn:0,nameColumn:1,amountColumn:2,idColumn:3,dateFormat:'mdy',amountConvention:'outflow-positive'};
 const file={fileName:'mapped.csv',content:'When,Who,Value,Reference\n11/03/2026,Transfer full description 4321,7,reference-1\n11/04/2026,Empty optional id,8,',csv:mapping};
 const files=[{...file,accountId:a.id},{...file,accountId:b.id}];
 let response=await post('/import-batch/preview',{files});assert.equal(response.status,200);assert.deepEqual((await response.json()).files.map(f=>f.importable),[2,2]);
 response=await post('/import-batch',{files});assert.equal(response.status,200);assert.equal((await response.json()).imported,4);
 assert.equal(db.prepare('SELECT count(*) n FROM bank_transaction WHERE account_id=?').get(a.providerAccountId).n,2);
 assert.equal(db.prepare('SELECT count(*) n FROM bank_transaction WHERE account_id=?').get(b.providerAccountId).n,2);
});

test('auto-matching ignores source-looking metadata outside the statement and every transaction reference',async t=>{
 const {post,account}=fixture(t);await account();
 const plain=ofx();plain.content=plain.content.replace('<BANKACCTFROM><ACCTID>99991234</BANKACCTFROM>','');
 const misplaced={...plain,content:plain.content.replace('<OFX>','<OFX><BANKACCTFROM><ACCTID>99991234</BANKACCTFROM>')};
 const txReference={...plain,content:plain.content.replace('</STMTTRN>','<BANKACCTFROM><ACCTID>99991234</BANKACCTFROM><BANKACCTTO><ACCTID>99991234</BANKACCTTO></STMTTRN>')};
 for(const file of [plain,misplaced,txReference]){
  const response=await post('/import-batch/preview',{files:[file]});assert.equal(response.status,200);const [f]=(await response.json()).files;assert.equal(f.status,'needs-account');assert.equal(f.accountId,null);
 }
});

function fixture(t) {
 const db=new Database(':memory:');
 for(const file of readdirSync(new URL('../server/migrations/',import.meta.url)).filter(f=>f.endsWith('.sql')&&!f.startsWith('0003_')).sort()) db.exec(readFileSync(new URL('../server/migrations/'+file,import.meta.url),'utf8'));
 t.after(()=>db.close());
 for(const id of ['alice','bob']) db.prepare('INSERT INTO user(id,name,email) VALUES(?,?,?)').run(id,id,id+'@example.test');
 const key=Buffer.alloc(32,7);
 const app=new Hono().route('/api/accounts',createBankAccountsRouter({database:db,getUserId:async c=>c.req.header('x-user')||null,getEncryptionKey:()=>key,trustedOrigins:['https://finance.example.test']}));
 const post=(path,body,user='alice',headers={})=>app.request('http://localhost/api/accounts'+path,{method:'POST',headers:{'content-type':'application/json','x-user':user,...headers},body:JSON.stringify(body)});
 const account=async (fields={},user='alice')=>{
  const response=await post('',{name:'Checking',institutionName:'Bank',type:'depository',subtype:'checking',currencyCode:'USD',mask:'1234',currentBalance:100,...fields},user);
  assert.equal(response.status,201);return (await response.json()).account;
 };
 const state=()=>({accounts:db.prepare('SELECT * FROM bank_account ORDER BY id').all(),items:db.prepare('SELECT * FROM bank_item ORDER BY item_id').all(),transactions:db.prepare('SELECT * FROM bank_transaction ORDER BY transaction_id').all()});
 return {db,key,app,post,account,state};
}
const csv=(fileName='activity.csv',rows='2026-11-01,Coffee,-5',extra={})=>({fileName,content:'Date,Description,Amount\n'+rows,...extra});
const ofx=(id='source-one',amount='-5',accountId='99991234',extra='',statement='STMTRS',accountTag='BANKACCTFROM',currency='USD')=>({fileName:'statement.qfx',content:`OFXHEADER:100\nVERSION:102\n\n<OFX><${statement}><CURDEF>${currency}<${accountTag}><ACCTID>${accountId}</${accountTag}><BANKTRANLIST><STMTTRN><DTPOSTED>20261101<TRNAMT>${amount}<NAME>Coffee<FITID>${id}${extra}</STMTTRN></BANKTRANLIST></${statement}></OFX>`});

test('batch preview preserves input order, requires a choice for unidentified CSV, and never writes',async t=>{
 const {post,account,state}=fixture(t);const a=await account();const before=state();
 const response=await post('/import-batch/preview',{files:[csv('activity.csv'),csv('chosen.csv',undefined,{accountId:a.id})]});
 assert.equal(response.status,200);
 const {files}=await response.json();assert.equal(files.length,2);
 assert.deepEqual(files.map(f=>[f.fileName,f.accountId,f.status,f.total,f.importable]),[['activity.csv',null,'needs-account',1,0],['chosen.csv',a.id,'ready',1,1]]);
 for(const f of files){assert.equal(typeof f.reason,'string');assert.deepEqual(f.errors,[]);assert.deepEqual(f.columns,['Date','Description','Amount']);assert.equal(f.mapping.amountColumn,2);assert.equal(f.duplicates,0);}
 assert.deepEqual(state(),before);
});

test('only unique statement source masks with matching currency and account type auto-match',async t=>{
 const {post,account,db}=fixture(t);const a=await account();
 const preview=async files=>{const r=await post('/import-batch/preview',{files});assert.equal(r.status,200);return (await r.json()).files;};
 let [f]=await preview([ofx('a','-5','99991234','<BANKACCTTO><ACCTID>77775678</BANKACCTTO><BANKACCTFROM><ACCTID>77775678</BANKACCTFROM>')]);
 assert.equal(f.accountId,a.id);assert.equal(f.status,'ready');
 for(const file of [ofx('a','-5','99995678'),ofx('a','-5','99991234','','STMTRS','BANKACCTFROM','EUR'),ofx('a','-5','99991234','','CCSTMTRS','CCACCTFROM'),csv('activity.csv')]) {
  [f]=await preview([file]);assert.equal(f.accountId,null);assert.equal(f.status,'needs-account');
 }
 const b=await account({name:'Other same mask'});
 [f]=await preview([ofx()]);assert.equal(f.accountId,null);assert.equal(f.status,'needs-account');assert.match(f.reason,/multiple|ambiguous/i);
 [f]=await preview([{...ofx(),accountId:a.id}]);assert.equal(f.status,'ready');assert.equal(f.accountId,a.id);
 db.prepare('UPDATE bank_account SET is_active=0 WHERE id=?').run(b.id);
 [f]=await preview([ofx()]);assert.equal(f.accountId,a.id);
 await account({},'bob');[f]=await preview([ofx()]);assert.equal(f.accountId,a.id,'Other users cannot create ambiguity');
 for(const file of [{...ofx('a','-5','99995678'),accountId:a.id},{...ofx('a','-5','99991234','','STMTRS','BANKACCTFROM','EUR'),accountId:a.id},{...ofx('a','-5','99991234','','CCSTMTRS','CCACCTFROM'),accountId:a.id}]) {
  [f]=await preview([file]);assert.equal(f.status,'error');assert.equal(f.importable,0);assert.ok(f.errors.length);
 }
});

test('filename account numbers automatically select unique destinations and preserve approval and idempotency',async t=>{
 const {post,account,state}=fixture(t);
 const a=await account({mask:'7461',type:'investment',subtype:'brokerage'});
 const b=await account({mask:'3243',type:'investment',subtype:'brokerage'});
 const c=await account({mask:'1283',type:'investment',subtype:'brokerage'});
 const files=['History_for_Account_Z30217461.csv','History_for_Account_250103243.csv','History_for_Account_X77621283.csv'].map(name=>csv(name));
 const before=state();
 const response=await post('/import-batch/preview',{files});assert.equal(response.status,200);
 const preview=(await response.json()).files;
 assert.deepEqual(preview.map(f=>[f.accountId,f.status,f.importable]),[a,b,c].map(a=>[a.id,'ready',1]));
 for(const f of preview) assert.match(f.reason,/file.*name/i);
 assert.deepEqual(state(),before);
 assert.equal((await post('/import-batch',{files})).status,400,'Automatic match still requires explicit approval destinations');
 const approved=files.map((f,i)=>({...f,accountId:preview[i].accountId}));
 assert.equal((await(await post('/import-batch',{files:approved})).json()).imported,3);
 assert.equal((await(await post('/import-batch/preview',{files})).json()).files.every(f=>f.importable===0&&f.duplicates===1),true);
});

test('filename matching respects ambiguity, ownership, manual choices and statement-source precedence',async t=>{
 const {post,account,db}=fixture(t);
 const a=await account(),b=await account({mask:'5678'});
 const preview=async file=>(await(await post('/import-batch/preview',{files:[file]})).json()).files[0];
 let f=await preview(csv('checking_1234.csv'));assert.equal(f.accountId,a.id);
 await account({},'bob');f=await preview(csv('checking_1234.csv'));assert.equal(f.accountId,a.id);
 const inactive=await account();db.prepare('UPDATE bank_account SET is_active=0 WHERE id=?').run(inactive.id);
 const saved=await account();db.prepare("UPDATE bank_item SET provider='imported' WHERE item_id=?").run(saved.itemId);
 f=await preview(csv('checking_1234.csv'));assert.equal(f.accountId,a.id);
 f=await preview(csv('accounts_1234_5678.csv'));assert.equal(f.accountId,null);assert.equal(f.status,'needs-account');
 await account();f=await preview(csv('checking_1234.csv'));assert.equal(f.accountId,null);assert.equal(f.status,'needs-account');
 f=await preview(csv('checking_1234.csv',undefined,{accountId:b.id}));assert.equal(f.accountId,b.id);assert.equal(f.status,'ready');
 f=await preview({...ofx('one','-5','99995678'),fileName:'checking_1234.qfx'});assert.equal(f.accountId,b.id,'Statement source wins over filename');
 f=await preview({...ofx('two','-5','99990000'),fileName:'checking_5678.qfx'});assert.equal(f.accountId,null,'Unknown statement source must not fall back to filename');
 f=await preview({...ofx('three','-5','99995678','','STMTRS','BANKACCTFROM','EUR'),fileName:'checking_5678.qfx'});assert.equal(f.accountId,null,'Filename cannot bypass currency validation');
});
