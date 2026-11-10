import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { readFile, readdir } from 'node:fs/promises';
import { applySqlMigration } from '../server/migration-utils.ts';
import { createBankAccountsRouter } from '../server/bank_accounts.ts';
import { decryptBankValue, encryptBankValue } from '../server/bank-crypto.ts';
import { groupInternalTransfers } from '../src/transaction-list.ts';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const key = Buffer.alloc(32,9);
async function fixture(trustedOrigins) {
 const db=new Database(':memory:'); db.pragma('foreign_keys=ON');
 const dir=new URL('../server/migrations/',import.meta.url);
 for(const file of (await readdir(dir)).filter(f=>f.endsWith('.sql')).sort()) applySqlMigration(db,await readFile(new URL(file,dir),'utf8'));
 for(const id of ['owner','other']) db.prepare('INSERT INTO user(id,name,email) VALUES(?,?,?)').run(id,id,id+'@example.test');
 let user='owner'; const router=createBankAccountsRouter({database:db,getUserId:async()=>user,getEncryptionKey:()=>key,trustedOrigins});
 const post=(path,body,headers={})=>router.request(path,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});
 return {db,router,post,setUser:id=>{user=id;}};
}
const input={name:'Checking',institutionName:'Local Bank',type:'depository',subtype:'checking',currencyCode:'USD',mask:'1234',currentBalance:500};
test('configured public and dev origins work behind proxies without trusting forwarding headers', async () => {
 const f=await fixture(['https://finance.example.test','http://localhost:5173']);
 try {
  for(const origin of ['https://finance.example.test','http://localhost:5173']) {
   const created=await f.post('/',input,{origin});assert.equal(created.status,201,origin);
   const {account}=await created.json();
   const path='/'+account.id+'/import';
   const file={fileName:'x.csv',content:'Date,Description,Amount\n2026-11-01,Shop,-1'};
   for(const suffix of ['/preview','']) assert.equal((await f.post(path+suffix,file,{origin})).status,200,origin+suffix);
  }
  assert.equal((await f.post('/',input,{origin:'https://evil.test','x-forwarded-host':'evil.test','x-forwarded-proto':'https'})).status,403);
 } finally {f.db.close();}
});
test('manual writes validate JSON, origin, field constraints and streamed size before persisting',async()=>{
 const f=await fixture();try {
 assert.equal((await f.post('/',input,{origin:'https://evil.test'})).status,403);
 assert.equal((await f.router.request('/',{method:'POST',body:'{}'})).status,400);
 assert.equal((await f.router.request('/',{method:'POST',headers:{'content-type':'application/json'},body:'{'})).status,400);
 for(const changed of [{name:''},{institutionName:'x'.repeat(201)},{type:'other'},{type:['credit']},{type:{toString:'credit'}},{subtype:''},{currencyCode:'usd'},{mask:'12ab'},{currentBalance:'5'}]) assert.equal((await f.post('/',{...input,...changed})).status,400,JSON.stringify(changed));
 const stream=new ReadableStream({start(c){for(let i=0;i<6;i++)c.enqueue(new TextEncoder().encode(' '.repeat(1024*1024)));c.close();}});
 assert.equal((await f.router.request(new Request('http://localhost/',{method:'POST',headers:{'content-type':'application/json'},body:stream,duplex:'half'}))).status,413);
 assert.equal(f.db.prepare('SELECT count(*) n FROM bank_item').get().n,0);
 assert.equal((await f.post('/',input,{origin:'http://localhost'})).status,201);
 f.setUser(null);assert.equal((await f.post('/',input)).status,401);
 }finally{f.db.close();}
});
test('manual account creation persists encrypted snapshots and server-owned capabilities',async()=>{
 const f=await fixture();try {
 const res=await f.post('/',{...input,source:'saved',canImport:false}); assert.equal(res.status,201);
 const {account}=await res.json(); assert.equal(account.source,'manual');assert.equal(account.canImport,true);assert.equal(account.availableBalance,null);assert.equal(account.officialName,null);
 assert.deepEqual((await (await f.router.request('/')).json()).accounts,[account]);
 const item=f.db.prepare('SELECT * FROM bank_item').get(); assert.equal(item.provider,'manual');assert.equal(decryptBankValue(item.encrypted_access_token,key),'');
 assert.ok(!f.db.serialize().includes(Buffer.from('Local Bank')));
 f.setUser('other');assert.deepEqual((await (await f.router.request('/')).json()).accounts,[]);
 }finally{f.db.close();}
});
test('preview validates all rows beyond its 50-row cap; invalid files and database failures are atomic',async()=>{
 const f=await fixture();try {
 const {account}=await (await f.post('/',input)).json();const path='/'+account.id+'/import';
 const lines=Array.from({length:60},(_,i)=>`2026-11-01,Entry ${i},-${i+1}`);
 const file={fileName:'long.csv',content:'Date,Description,Amount\n'+lines.join('\n')};
 let preview=await (await f.post(path+'/preview',file)).json();assert.equal(preview.total,60);assert.equal(preview.transactions.length,50);assert.equal(preview.previewTruncated,true);assert.equal(preview.importable,60);
 const before=f.db.serialize();
 const invalid={...file,content:file.content+'\n2026-02-30,Invalid,9'};
 preview=await (await f.post(path+'/preview',invalid)).json();assert.equal(preview.total,61);assert.equal(preview.importable,0);assert.ok(preview.errors.length);
 assert.equal((await f.post(path,invalid)).status,400);assert.deepEqual(f.db.serialize(),before);
 const unknown={fileName:'map.csv',content:'When,Who,Value\n11/01/2026,Coffee,-2'};
 preview=await (await f.post(path+'/preview',unknown)).json();assert.deepEqual(preview.columns,['When','Who','Value']);assert.equal(preview.mapping,null);assert.ok(preview.errors.length);
 assert.equal((await f.post(path,unknown)).status,400);assert.deepEqual(f.db.serialize(),before);
 f.db.exec("CREATE TRIGGER fail_import BEFORE INSERT ON bank_transaction WHEN (SELECT count(*) FROM bank_transaction)>0 BEGIN SELECT RAISE(ABORT,'injected write failure'); END");
 const beforeFailure=f.db.serialize();assert.equal((await f.post(path,file)).status,500);assert.equal(f.db.prepare('SELECT count(*) n FROM bank_transaction').get().n,0);assert.deepEqual(f.db.serialize(),beforeFailure);
 f.db.exec('DROP TRIGGER fail_import');
 assert.equal((await (await f.post(path,file)).json()).imported,60);
 assert.equal((await (await f.router.request('/transactions/all')).json()).transactions.length,60);
 const overlapping={fileName:'overlap.csv',content:'Date,Description,Amount\n'+lines.slice(30).join('\n')+'\n2026-11-02,Fresh,-99'};
 const counts=await (await f.post(path,overlapping)).json();assert.equal(counts.imported,1);assert.equal(counts.skipped,30);
 assert.equal((await (await f.router.request('/')).json()).accounts[0].currentBalance,500);
 }finally{f.db.close();}
});
test('only owner-scoped manual accounts accept imports, with authenticated same-origin JSON writes and no network',async t=>{
 const f=await fixture();try {
 const http=(await import('node:http')).default,https=(await import('node:https')).default;
 const {syncBuiltinESMExports}=await import('node:module');
 let networkCalls=0;const forbidden=()=>{networkCalls++;throw Error('Network forbidden');};
 t.mock.method(globalThis,'fetch',forbidden);
 for(const module of [http,https])for(const method of ['get','request'])t.mock.method(module,method,forbidden);
 syncBuiltinESMExports();
 const {account}=await (await f.post('/',input)).json();const path='/'+account.id+'/import';
 const file={fileName:'x.csv',content:'Date,Description,Amount\n2026-11-01,Shop,-1'};
 for(const suffix of ['', '/preview']) {
 assert.equal((await f.post(path+suffix,file,{origin:'https://evil.test'})).status,403);
 assert.equal((await f.router.request(path+suffix,{method:'POST',body:JSON.stringify(file)})).status,400);
 f.setUser(null);assert.equal((await f.post(path+suffix,file)).status,401);
 f.setUser('other');assert.equal((await f.post(path+suffix,file)).status,404);f.setUser('owner');
 }
 assert.equal((await f.post(path+'/preview',file)).status,200);
 assert.equal((await f.post(path,file)).status,200);assert.equal(networkCalls,0);
 f.db.prepare("UPDATE bank_item SET provider='imported'").run();
 for(const suffix of ['', '/preview'])assert.equal((await f.post(path+suffix,file)).status,409);
 const saved=(await (await f.router.request('/')).json()).accounts[0];assert.equal(saved.source,'saved');assert.equal(saved.canImport,false);
 assert.equal(f.db.prepare('SELECT count(*) n FROM bank_transaction').get().n,1);
 }finally{t.mock.restoreAll();(await import('node:module')).syncBuiltinESMExports();f.db.close();}
});
test('OFX correction preview and commit reject the whole file without changing any stored bytes',async()=>{
 const f=await fixture();try {
  const {account}=await (await f.post('/',input)).json();const path='/'+account.id+'/import';
  for(const xml of [false,true]) {
   const field=(tag,value)=>`<${tag}>${value}${xml?`</${tag}>`:''}`;
   const transaction=(id,amount,correction='')=>'<STMTTRN>'+field('DTPOSTED','20261101')+field('TRNAMT',amount)+field('NAME','Shop')+field('FITID',id)+correction+'</STMTTRN>';
   const file=rows=>({fileName:xml?'statement.qfx':'statement.ofx',content:(xml?'<?xml version="1.0"?>':'OFXHEADER:100\nVERSION:102\n\n')+'<OFX><STMTRS>'+field('CURDEF','USD')+'<BANKTRANLIST>'+rows+'</BANKTRANLIST></STMTRS></OFX>'});
   assert.equal((await f.post(path,file(transaction('original','-25')))).status,200);
   const before=f.db.serialize();
   for(const correction of [field('CORRECTFITID','original'),field('correctaction','REPLACE'),field('CoRrEcTaCtIoN','DELETE'),field('correctfitid','original')+field('CORRECTACTION','REPLACE'),field('CORRECTFITID','original')+field('correctaction','DELETE')]) {
    for(const prefix of ['',transaction('fresh','-3')]) {
     const corrected=file(prefix+transaction('replacement','-20',correction));
     const response=await f.post(path+'/preview',corrected);assert.equal(response.status,200);
     const preview=await response.json();
     assert.match(preview.errors.join(' '),/correction.*unsupported/i);
     assert.equal(preview.importable,0);
     assert.deepEqual(f.db.serialize(),before,'Preview must not change any stored bytes');
     assert.equal((await f.post(path,corrected)).status,400);
     assert.deepEqual(f.db.serialize(),before,'Rejected corrections must not import even a preceding fresh row');
    }
   }
   const stored=(await (await f.router.request('/'+account.id+'/transactions')).json()).transactions;
   assert.equal(stored.length,1);assert.equal(stored[0].amount,25);
  }
 }finally{f.db.close();}
});
test('imported OFX and CSV descriptions group reciprocal and Fidelity one-sided transfers through the existing algorithm',async()=>{
 const f=await fixture();try {
 const create=async values=>(await (await f.post('/',{...input,...values})).json()).account;
 const checking=await create({name:'Checking',mask:'1257'}),savings=await create({name:'Savings',mask:'4753'}),brokerage=await create({name:'Brokerage',institutionName:'Fidelity Investments',type:'investment',subtype:'brokerage',mask:'1283'});
 const ofx={fileName:'checking.qfx',content:'OFXHEADER:100\n\n<OFX><STMTRS><CURDEF>USD<BANKTRANLIST><STMTTRN><DTPOSTED>20261101<TRNAMT>-25<NAME>Internet transfer to<MEMO>Savings account XXXXXX4753<FITID>outgoing</STMTTRN><STMTTRN><DTPOSTED>20261102<TRNAMT>400<NAME>X77621283 708XN<MEMO>FID BKG SVC LLC ACH<FITID>fidelity</STMTTRN></BANKTRANLIST></STMTRS></OFX>'};
 assert.equal((await f.post('/'+checking.id+'/import',ofx)).status,200);
 const incoming={fileName:'savings.csv',content:'Date,Description,Amount\n2026-11-01,Internet transfer from Checking account XXXXXX1257,25'};
 assert.equal((await f.post('/'+savings.id+'/import',incoming)).status,200);
 const all=await (await f.router.request('/transactions/all')).json();
 const groups=groupInternalTransfers(all.transactions,all.accounts);
 assert.equal(groups.length,2);assert.ok(groups.every(g=>g.type==='transfer'));
 assert.ok(groups.some(g=>g.transactions.length===2 && g.fromAccount.id===checking.id && g.toAccount.id===savings.id));
 assert.ok(groups.some(g=>g.transactions.length===1 && g.fromAccount.id===brokerage.id && g.toAccount.id===checking.id));
 assert.equal((await (await f.post('/'+checking.id+'/import',ofx)).json()).skipped,2);
 assert.equal((await f.post('/'+checking.id+'/import',{...ofx,content:ofx.content.replace('<TRNAMT>-25','<TRNAMT>-26')})).status,409);
 }finally{f.db.close();}
});
test('exported production mount accepts writes and reads encrypted imported data in an isolated process',async()=>{
 const dir=await mkdtemp(join(process.env.TMPDIR||tmpdir(),'manual-mount-'));
 try {
 const script=`import assert from 'node:assert/strict';import {Hono} from 'hono';import {runMigrations,sqliteClient as db,closeDatabase} from './server/database.ts';import {auth} from './server/auth.ts';import {bankAccountsRouter} from './server/bank_accounts.ts';await runMigrations();db.exec("INSERT INTO user(id,name,email) VALUES('owner','Owner','owner@example.test')");auth.api.getSession=async()=>({user:{id:'owner'}});const app=new Hono().route('/api/accounts',bankAccountsRouter);const request=(path,body)=>app.request(path,{method:'POST',headers:{'content-type':'application/json',origin:'http://localhost'},body:JSON.stringify(body)});const res=await request('/api/accounts',${JSON.stringify(input)});assert.equal(res.status,201);const {account}=await res.json();const imported=await request('/api/accounts/'+account.id+'/import',{fileName:'x.csv',content:'Date,Description,Amount\\n2026-11-01,Mounted,-7'});assert.equal(imported.status,200);assert.equal((await imported.json()).imported,1);assert.equal((await (await app.request('/api/accounts/'+account.id+'/transactions')).json()).transactions[0].amount,7);await closeDatabase();console.log('production mounted writes verified');`;
 const result=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',script],{cwd:new URL('..',import.meta.url),encoding:'utf8',env:{...process.env,DATABASE_PATH:join(dir,'bank.sqlite'),BETTER_AUTH_SECRET:'manual-test-secret-that-is-at-least-32-characters',ORIGIN_URL:'http://localhost'}});
 assert.equal(result.status,0,result.stdout+result.stderr);assert.match(result.stdout,/production mounted writes verified/);
 const persisted=new Database(join(dir,'bank.sqlite'));try{assert.equal(persisted.prepare('SELECT count(*) n FROM bank_transaction').get().n,1);}finally{persisted.close();}
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('corrupt stored import metadata fails closed without returning decrypted private data',async()=>{
 const f=await fixture();try {
 const {account}=await (await f.post('/',input)).json();const path='/'+account.id+'/import';
 const file={fileName:'x.csv',content:'Date,Description,Amount,ID\n2026-11-01,Shop,-1,stable'};
 assert.equal((await f.post(path,file)).status,200);
 f.db.prepare('UPDATE bank_transaction SET encrypted_data=?').run(encryptBankValue('sensitive-private-invalid-json',key));
 const before=f.db.serialize();
 for(const suffix of ['/preview','']){const response=await f.post(path+suffix,file);assert.equal(response.status,500);assert.ok(!JSON.stringify(await response.json()).includes('sensitive-private'));}
 assert.deepEqual(f.db.serialize(),before);
 }finally{f.db.close();}
});
test('stable CSV source IDs reject changed contents atomically and stay scoped per account',async()=>{
 const f=await fixture();try {
 const {account}=await (await f.post('/',input)).json();const path='/'+account.id+'/import';
 const file=content=>({fileName:'ids.csv',content:'Date,Description,Amount,ID\n'+content});
 assert.equal((await f.post(path,file('2026-11-01,Original,-10,private-id'))).status,200);
 const before=f.db.serialize();
 const conflict=file('2026-11-02,New,-2,new-id\n2026-11-01,Changed,-11,private-id');
 const preview=await (await f.post(path+'/preview',conflict)).json();assert.equal(preview.importable,0);assert.match(preview.errors.join(' '),/conflict/i);
 assert.equal((await f.post(path,conflict)).status,409);assert.deepEqual(f.db.serialize(),before);
 assert.equal((await f.post(path,file('2026-11-03,One,-3,repeat\n2026-11-03,Two,-4,repeat'))).status,409);assert.deepEqual(f.db.serialize(),before);
 const {account:second}=await (await f.post('/',input)).json();assert.equal((await (await f.post('/'+second.id+'/import',file('2026-11-01,Original,-10,private-id'))).json()).imported,1);
 assert.ok(!f.db.prepare('SELECT transaction_id FROM bank_transaction').all().some(t=>t.transaction_id.includes('private-id')));
 }finally{f.db.close();}
});
test('CSV preview and commit persist canonical encrypted transactions idempotently without changing balances',async()=>{
 const f=await fixture();try {
 const {account}=await (await f.post('/',input)).json();
 const file={fileName:'statement.CSV',content:'Date,Description,Amount\r\n2026-11-01,"Coffee, shop",-5.25\r\n2026-11-01,"Coffee, shop",-5.25\r\n2026-11-02,Salary,100',csv:{dateFormat:'ymd',amountConvention:'inflow-positive'}};
 const path='/'+account.id+'/import';
 const res=await f.post(path+'/preview',file);assert.equal(res.status,200);
 const preview=await res.json();assert.equal(preview.total,3);assert.equal(preview.importable,3);assert.equal(preview.transactions[0].amount,5.25);assert.equal(preview.mapping.dateColumn,0);
 assert.equal(f.db.prepare('SELECT count(*) n FROM bank_transaction').get().n,0);
 const committed=await f.post(path,file);assert.equal(committed.status,200);assert.deepEqual(await committed.json(),{imported:3,skipped:0,account});
 assert.equal((await (await f.post(path+'/preview',file)).json()).duplicates,3);
 assert.deepEqual(await (await f.post(path,file)).json(),{imported:0,skipped:3,account});
 const tx=(await (await f.router.request('/'+account.id+'/transactions')).json()).transactions;
 assert.equal(tx.length,3);assert.ok(tx.every(t=>t.account_id===account.providerAccountId));assert.deepEqual(tx.map(t=>t.amount).sort((a,b)=>a-b),[-100,5.25,5.25]);
 assert.ok(!f.db.serialize().includes(Buffer.from('Coffee')));
 f.setUser('other');assert.equal((await f.post(path,file)).status,404);
 }finally{f.db.close();}
});
