import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {readFileSync,readdirSync} from 'node:fs';
import {createBankAccountsRouter} from '../server-dist/bank_accounts.js';
import {decryptBankValue,encryptBankValue} from '../server-dist/bank-crypto.js';

function fixture(t) {
 const db=new Database(':memory:');db.pragma('foreign_keys=ON');
 for(const file of readdirSync(new URL('../server/migrations/',import.meta.url)).filter(f=>f.endsWith('.sql')&&!f.startsWith('0003_')).sort())db.exec(readFileSync(new URL('../server/migrations/'+file,import.meta.url),'utf8'));
 t.after(()=>db.close());for(const id of ['owner','other'])db.prepare('INSERT INTO user(id,name,email) VALUES(?,?,?)').run(id,id,id+'@example.test');
 const key=Buffer.alloc(32,3);let user='owner';
 const app=createBankAccountsRouter({database:db,getUserId:async()=>user,getEncryptionKey:()=>key,now:()=>new Date('2026-11-12T12:00:00Z')});
 const send=(path,body,method='POST',headers={})=>app.request(path,{method,headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});
 const create=async(fields={})=>{const r=await send('/',{name:'Checking',institutionName:'Bank',type:'depository',subtype:'checking',currencyCode:'USD',...fields});assert.equal(r.status,201);return(await r.json()).account;};
 const read=async id=>(await(await app.request('/')).json()).accounts.find(a=>a.id===id);
 const patch=(id,amount,date)=>send('/'+id+'/balance',{currentBalance:amount,balanceDate:date},'PATCH');
 const snapshot=id=>JSON.parse(decryptBankValue(db.prepare('SELECT encrypted_data FROM bank_account WHERE id=?').get(id).encrypted_data,key));
 const legacy=(id,balance)=>{const s=snapshot(id);delete s.balanceReference;s.currentBalance=balance;db.prepare('UPDATE bank_account SET encrypted_data=? WHERE id=?').run(encryptBankValue(JSON.stringify(s),key),id);};
 return{db,key,app,send,create,read,patch,snapshot,legacy,setUser:id=>{user=id;}};
}
const file=(rows,extra={})=>({fileName:'activity.csv',content:'Date,Description,Amount,ID\n'+rows,...extra});
const rows='2026-10-31,Before,-10,before\n2026-11-01,Same day,-20,same\n2026-11-02,Later,-5,later\n2026-11-03,Inflow,12,inflow';
const impact=(overrides={})=>({referenceBalance:100,referenceDate:'2026-11-01',startingBalance:100,historicalCount:2,appliedCount:2,appliedAmount:7,duplicates:0,balanceAfterImport:107,canApply:true,...overrides});

test('new accounts default to unverified zero; explicit balances are dated and encrypted',async t=>{
 const f=fixture(t);
 for(const fields of [{},{currentBalance:null}]){const a=await f.create(fields);assert.equal(a.currentBalance,0);assert.deepEqual(a.balanceReference,{amount:0,date:'2026-11-12',verified:false});
  const p=await(await f.send('/'+a.id+'/import/preview',file('2026-11-12,Today,-2,today'))).json();assert.equal(p.balanceImpact.canApply,true);assert.match(p.balanceImpact.reason,/default.*unverified|unverified.*default/i);
 }
 const a=await f.create({currentBalance:1234.56,balanceDate:'2024-02-29'});assert.deepEqual(a.balanceReference,{amount:1234.56,date:'2024-02-29',verified:true});
 assert.deepEqual(f.snapshot(a.id).balanceReference,a.balanceReference);assert.ok(!f.db.serialize().includes(Buffer.from('balanceReference')));
});

test('create and patch validate real nonfuture dates, cents and safe monetary limits',async t=>{
 const f=fixture(t),a=await f.create();
 for(const date of ['2026-02-29','2024-02-30','2026-13-01','2026-11-13','2026-1-01','0000-01-01','x',null,7]){
  assert.equal((await f.patch(a.id,1,date)).status,400,String(date));
  assert.equal((await f.send('/',{name:'A',institutionName:'B',type:'depository',subtype:'checking',currencyCode:'USD',balanceDate:date})).status,400,String(date));
 }
 for(const amount of [null,'1',0.001,1.005,1e20,90071992547410,90071992547409.9,-90071992547409.9,1000000000000.01,-1000000000000.01])assert.equal((await f.patch(a.id,amount,'2026-11-01')).status,400,String(amount));
 for(const amount of [0,-123.45,0.29,1000000000000,-1000000000000])assert.equal((await f.patch(a.id,amount,'2024-02-29')).status,200,String(amount));
 assert.equal((await f.send('/'+a.id+'/balance',{currentBalance:2},'PATCH')).status,400);
 assert.equal((await f.send('/'+a.id+'/balance',{currentBalance:2,balanceDate:'2026-11-01'},'PATCH',{origin:'https://evil.test'})).status,403);
});

test('end-of-day references apply only unique later activity and recalculate all reads and reanchors',async t=>{
 const f=fixture(t),a=await f.create({currentBalance:100,balanceDate:'2026-11-01'}),path='/'+a.id+'/import';
 const before=f.db.serialize(),preview=await(await f.send(path+'/preview',file(rows))).json();
 assert.deepEqual(preview.balanceImpact,impact());assert.equal(typeof preview.previewToken,'string');assert.deepEqual(f.db.serialize(),before);
 const response=await f.send(path,{...file(rows),previewToken:preview.previewToken});assert.equal(response.status,200);assert.equal((await response.json()).account.currentBalance,107);
 assert.equal((await f.read(a.id)).currentBalance,107);assert.equal(f.snapshot(a.id).currentBalance,100);
 const repeat=await(await f.send(path+'/preview',file(rows))).json();assert.deepEqual(repeat.balanceImpact,impact({startingBalance:107,historicalCount:0,appliedCount:0,appliedAmount:0,duplicates:4}));
 assert.equal((await(await f.send(path,file(rows))).json()).account.currentBalance,107);
 assert.equal((await(await f.patch(a.id,200,'2026-11-02')).json()).account.currentBalance,212);
 assert.equal((await(await f.patch(a.id,50,'2026-10-30')).json()).account.currentBalance,27);
 const detail=await(await f.app.request('/'+a.id+'/transactions')).json();assert.equal(detail.account.currentBalance,27);
 assert.equal((await(await f.app.request('/items')).json()).connections[0].accounts[0].currentBalance,27);
 assert.equal((await(await f.app.request('/transactions/all')).json()).accounts[0].currentBalance,27);
});

test('legacy unknown and undated numbers stay fixed until explicitly reanchored; investments never infer valuations',async t=>{
 const f=fixture(t);
 for(const balance of [undefined,null,100,1e20]){
  const a=await f.create();f.legacy(a.id,balance);const path='/'+a.id+'/import';
  const p=await(await f.send(path+'/preview',file(rows))).json();assert.equal(p.balanceImpact.canApply,false);assert.ok(p.balanceImpact.reason);assert.equal(p.balanceImpact.balanceAfterImport,balance??null);
  assert.equal((await(await f.send(path,file(rows))).json()).account.currentBalance,balance??null);
  assert.equal((await(await f.patch(a.id,100,'2026-11-01')).json()).account.currentBalance,107);
 }
 const a=await f.create({type:'investment',currentBalance:100,balanceDate:'2026-11-01'}),path='/'+a.id+'/import';
 const p=await(await f.send(path+'/preview',file(rows))).json();assert.equal(p.balanceImpact.canApply,false);assert.match(p.balanceImpact.reason,/investment|valuation/i);assert.equal(p.balanceImpact.appliedAmount,0);assert.equal(p.balanceImpact.balanceAfterImport,100);
 assert.equal((await(await f.send(path,file(rows))).json()).account.currentBalance,100);
});

test('credit and loan owed use positive outflow signs, pennies remain exact, pending rows are excluded',async t=>{
 const f=fixture(t);
 for(const type of ['credit','loan','depository']){
  const a=await f.create({type,currentBalance:100,balanceDate:'2026-11-01'}),path='/'+a.id+'/import';
  const r=await f.send(path,file('2026-11-02,Purchase,-0.1,a\n2026-11-03,Purchase,-0.2,b'));
  assert.equal((await r.json()).account.currentBalance,type==='depository'?99.7:100.3);
  const row=f.db.prepare('SELECT * FROM bank_transaction WHERE account_id=? LIMIT 1').get(a.providerAccountId),payload=JSON.parse(decryptBankValue(row.encrypted_data,f.key));payload.pending=true;
  f.db.prepare('UPDATE bank_transaction SET encrypted_data=? WHERE transaction_id=?').run(encryptBankValue(JSON.stringify(payload),f.key),row.transaction_id);
  assert.equal((await f.read(a.id)).currentBalance,type==='depository'?99.8:100.2);
 }
});

test('balance edits require authentication, ownership, active manual account and never overwrite saved providers',async t=>{
 const f=fixture(t),a=await f.create();
 f.setUser(null);assert.equal((await f.patch(a.id,1,'2026-11-01')).status,401);
 f.setUser('other');assert.equal((await f.patch(a.id,1,'2026-11-01')).status,404);f.setUser('owner');
 f.db.prepare("UPDATE bank_item SET provider='imported' WHERE item_id=?").run(a.itemId);
 assert.equal((await f.patch(a.id,1,'2026-11-01')).status,409);
 f.db.prepare('UPDATE bank_account SET is_active=0 WHERE id=?').run(a.id);assert.equal((await f.patch(a.id,1,'2026-11-01')).status,404);
});

test('single preview tokens reject stale references, activity, changed files and duplicate classifications without writes',async t=>{
 const f=fixture(t),a=await f.create({currentBalance:100,balanceDate:'2026-11-01'}),path='/'+a.id+'/import',body=file(rows);
 const preview=async()=> (await(await f.send(path+'/preview',body)).json()).previewToken;
 let token=await preview();await f.patch(a.id,100,'2026-11-02');let before=f.db.serialize();
 assert.equal((await f.send(path,{...body,previewToken:token})).status,409);assert.deepEqual(f.db.serialize(),before);
 token=await preview();assert.equal((await f.send(path,file('2026-11-04,Other,-2,other'))).status,200);before=f.db.serialize();
 assert.equal((await f.send(path,{...body,previewToken:token})).status,409);assert.deepEqual(f.db.serialize(),before);
 token=await preview();assert.equal((await f.send(path,{...file(rows+'\n2026-11-05,Changed,2,new'),previewToken:token})).status,409);
 assert.equal((await f.send(path,body)).status,200);before=f.db.serialize();assert.equal((await f.send(path,{...body,previewToken:token})).status,409);assert.deepEqual(f.db.serialize(),before);
});

test('batch previews are cumulative per account, exclude overlaps, preserve order and accept explicit auto-match approval',async t=>{
 const f=fixture(t),a=await f.create({mask:'1234',currentBalance:100,balanceDate:'2026-11-01'}),b=await f.create({currentBalance:50,balanceDate:'2026-11-01'});
 const files=[file('2026-11-01,Old,-3,old\n2026-11-02,New,-5,new',{fileName:'checking_1234.csv'}),file('2026-11-02,New,-5,new\n2026-11-03,Income,12,income',{accountId:a.id}),file('2026-11-02,Separate,-2,separate',{accountId:b.id})];
 const p=await(await f.send('/import-batch/preview',{files})).json();assert.equal(typeof p.previewToken,'string');
 assert.deepEqual(p.files.map(v=>v.balanceImpact),[impact({historicalCount:1,appliedCount:1,appliedAmount:-5,balanceAfterImport:95}),impact({startingBalance:95,historicalCount:0,appliedCount:1,appliedAmount:12,duplicates:1}),impact({referenceBalance:50,startingBalance:50,historicalCount:0,appliedCount:1,appliedAmount:-2,balanceAfterImport:48})]);
 const approved=files.map((v,i)=>({...v,accountId:p.files[i].accountId}));
 const r=await f.send('/import-batch',{files:approved,previewToken:p.previewToken});assert.equal(r.status,200);assert.equal((await r.json()).imported,4);
 assert.equal((await f.read(a.id)).currentBalance,107);assert.equal((await f.read(b.id)).currentBalance,48);
});

test('batch stale tokens and late failures roll back every account and transaction',async t=>{
 const f=fixture(t),a=await f.create({currentBalance:100,balanceDate:'2026-11-01'}),b=await f.create({currentBalance:50,balanceDate:'2026-11-01'});
 const files=[file('2026-11-02,One,-5,one',{accountId:a.id}),file('2026-11-03,Two,-2,two',{accountId:b.id})];
 const p=await(await f.send('/import-batch/preview',{files})).json();await f.patch(b.id,51,'2026-11-01');let before=f.db.serialize();
 assert.equal((await f.send('/import-batch',{files,previewToken:p.previewToken})).status,409);assert.deepEqual(f.db.serialize(),before);
 f.db.exec("CREATE TRIGGER fail_second BEFORE INSERT ON bank_transaction WHEN (SELECT count(*) FROM bank_transaction)>0 BEGIN SELECT RAISE(ABORT,'failure'); END");before=f.db.serialize();
 assert.equal((await f.send('/import-batch',{files})).status,500);assert.deepEqual(f.db.serialize(),before);
});

test('concurrent single and batch confirmations serialize approval and reject the stale writer atomically',async t=>{
 const f=fixture(t),a=await f.create({currentBalance:100,balanceDate:'2026-11-01'}),b=await f.create({currentBalance:50,balanceDate:'2026-11-01'});
 const shared=file('2026-11-02,Shared,-5,shared',{accountId:a.id});
 const single=await(await f.send('/'+a.id+'/import/preview',shared)).json();
 const files=[file('2026-11-02,Independent,-2,independent',{accountId:b.id}),shared];
 const batch=await(await f.send('/import-batch/preview',{files})).json();
 const responses=await Promise.all([f.send('/'+a.id+'/import',{...shared,previewToken:single.previewToken}),f.send('/import-batch',{files,previewToken:batch.previewToken})]);
 assert.deepEqual(responses.map(r=>r.status),[200,409]);
 assert.equal(f.db.prepare('SELECT count(*) n FROM bank_transaction').get().n,1);
 assert.equal((await f.read(a.id)).currentBalance,95);assert.equal((await f.read(b.id)).currentBalance,50);
});

test('all saved rows, out-of-order imports and repeated IDs count once without snapshot drift',async t=>{
 const f=fixture(t),a=await f.create({currentBalance:100,balanceDate:'2026-11-01'}),path='/'+a.id+'/import';
 const content=Array.from({length:70},(_,i)=>`2026-11-04,Entry ${i},-0.01,id-${i}`).join('\n');
 assert.equal((await(await f.send(path,file(content))).json()).account.currentBalance,99.3);
 const incoming=file('2026-11-02,Earlier later-day,2,earlier\n2026-10-01,Old,-500,old\n2026-11-02,Earlier later-day,2,earlier');
 const p=await(await f.send(path+'/preview',incoming)).json();
 assert.deepEqual(p.balanceImpact,impact({startingBalance:99.3,historicalCount:1,appliedCount:1,appliedAmount:2,duplicates:1,balanceAfterImport:101.3}));
 assert.equal((await(await f.send(path,{...incoming,previewToken:p.previewToken})).json()).account.currentBalance,101.3);
 assert.equal(f.snapshot(a.id).currentBalance,100);assert.equal(f.db.prepare('SELECT count(*) n FROM bank_transaction').get().n,72);
});

test('unsafe cent-roundtrip references including the reviewer reproduction reject before account creation',async t=>{
 const f=fixture(t);
 for(const currentBalance of [90071992547409.9,-90071992547409.9,1000000000000.01,-1000000000000.01]){
  const before=f.db.serialize();
  assert.equal((await f.send('/',{name:'Precision',institutionName:'Bank',type:'depository',subtype:'checking',currencyCode:'USD',currentBalance,balanceDate:'2026-11-01'})).status,400,String(currentBalance));
  assert.deepEqual(f.db.serialize(),before);
 }
});

test('maximum supported positive and negative references preserve cumulative penny batch previews and readbacks',async t=>{
 const f=fixture(t);
 for(const type of ['depository','credit','loan'])for(const sign of [1,-1]){
  const a=await f.create({type,currentBalance:sign*1000000000000,balanceDate:'2026-11-01'});
  const amount=type==='depository'?-sign:sign;
  let expectedCents=BigInt(sign)*100000000000000n;
  for(let batch=0;batch<2;batch++){
   const files=[0,1].map(i=>file(`2026-11-02,Penny,${amount<0?'-':''}0.01,penny-${batch}-${i}`,{accountId:a.id}));
   const before=f.db.serialize(),response=await f.send('/import-batch/preview',{files});assert.equal(response.status,200);
   const p=await response.json();assert.equal(typeof p.previewToken,'string');assert.deepEqual(f.db.serialize(),before);
   for(const entry of p.files){
    assert.equal(entry.balanceImpact.startingBalance,Number(expectedCents)/100);
    expectedCents-=BigInt(sign);
    assert.equal(entry.balanceImpact.appliedAmount,-sign*0.01);
    assert.equal(entry.balanceImpact.balanceAfterImport,Number(expectedCents)/100);
   }
   assert.equal((await f.send('/import-batch',{files,previewToken:p.previewToken})).status,200);
   assert.equal((await f.read(a.id)).currentBalance,p.files[1].balanceImpact.balanceAfterImport);
   assert.equal(f.snapshot(a.id).currentBalance,sign*1000000000000);
  }
 }
});

test('penny boundary crossings reject single and cumulative batch writes atomically in either balance direction',async t=>{
 const f=fixture(t),b=await f.create();
 for(const type of ['depository','credit','loan'])for(const sign of [1,-1]){
  const a=await f.create({type,currentBalance:sign*1000000000000,balanceDate:'2026-11-01'});
  const amount=type==='depository'?sign:-sign;
  const penny=file(`2026-11-02,Penny,${amount<0?'-':''}0.01,overflow`,{accountId:a.id});
  let before=f.db.serialize();
  assert.equal((await f.send('/'+a.id+'/import',penny)).status,409);assert.deepEqual(f.db.serialize(),before);
  assert.equal((await f.patch(a.id,Number(BigInt(sign)*99999999999999n)/100,'2026-11-01')).status,200);
  before=f.db.serialize();
  const files=[file('2026-11-02,Good,-2,good',{accountId:b.id}),penny,file(`2026-11-03,Penny,${amount<0?'-':''}0.01,overflow-2`,{accountId:a.id})];
  assert.equal((await f.send('/import-batch',{files})).status,409);assert.deepEqual(f.db.serialize(),before);
  assert.equal(f.db.prepare('SELECT count(*) n FROM bank_transaction').get().n,0);
 }
});

test('fresh amounts and applied deltas obey the same bound even when the final balance would fit',async t=>{
 const f=fixture(t);
 for(const sign of [1,-1]){
  const a=await f.create({currentBalance:-sign*1000000000000,balanceDate:'2026-11-01'}),path='/'+a.id+'/import';
  const tooLarge=file(`2026-11-02,Too large,${sign<0?'-':''}1000000000000.01,large\n2026-11-03,Offset,${sign>0?'-':''}1000000000000.01,offset`,{accountId:a.id});
  const delta=file(`2026-11-02,First,${sign<0?'-':''}600000000000,first\n2026-11-03,Second,${sign<0?'-':''}600000000000,second`,{accountId:a.id});
  for(const body of [tooLarge,delta]){
   const before=f.db.serialize();
   assert.equal((await f.send(path,body)).status,409);assert.deepEqual(f.db.serialize(),before);
   assert.equal((await f.send('/import-batch',{files:[body]})).status,409);assert.deepEqual(f.db.serialize(),before);
  }
 }
});

test('unsafe resulting balances reject single and batch writes without leaving unreadable accounts',async t=>{
 const f=fixture(t),a=await f.create({currentBalance:1000000000000,balanceDate:'2026-11-01'}),b=await f.create();
 const tooMuch=file('2026-11-02,Overflow,100,overflow',{accountId:a.id});
 let before=f.db.serialize();assert.equal((await f.send('/'+a.id+'/import',tooMuch)).status,409);assert.deepEqual(f.db.serialize(),before);
 const files=[file('2026-11-02,Good,-2,good',{accountId:b.id}),tooMuch];
 assert.equal((await f.send('/import-batch',{files})).status,409);assert.deepEqual(f.db.serialize(),before);
 // A reanchor must validate its derived balance before committing the snapshot.
 await f.patch(a.id,0,'2026-11-01');await f.send('/'+a.id+'/import',tooMuch);before=f.db.serialize();
 assert.equal((await f.patch(a.id,1000000000000,'2026-11-01')).status,409);assert.deepEqual(f.db.serialize(),before);
});

test('negative credit and loan owed balances are overpayment assets; net-worth observations never backfill dates',async t=>{
 const f=fixture(t);await f.create({currentBalance:100,balanceDate:'2026-10-01'});
 for(const type of ['credit','loan']){
  const a=await f.create({type,currentBalance:5,balanceDate:'2026-11-01'});
  assert.equal((await(await f.send('/'+a.id+'/import',file('2026-11-02,Repayment,7,repayment'))).json()).account.currentBalance,-2);
 }
 const summary=await(await f.app.request('/net-worth')).json();assert.equal(summary.total,104);
 assert.deepEqual(summary.points,[{date:'2026-11-12',total:104}]);
});