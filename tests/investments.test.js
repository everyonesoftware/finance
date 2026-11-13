import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { createBankAccountsRouter } from '../server-dist/bank_accounts.js';
import { decryptBankValue, encryptBankValue } from '../server-dist/bank-crypto.js';

function fixture(t) {
 const db = new Database(':memory:'); db.pragma('foreign_keys=ON');
 // 0003 is the legacy-only rename; fresh 0001 already uses the renamed tables.
 for (const file of readdirSync(new URL('../server/migrations/', import.meta.url)).filter(f => f.endsWith('.sql') && !f.startsWith('0003_')).sort()) db.exec(readFileSync(new URL('../server/migrations/' + file, import.meta.url), 'utf8'));
 t.after(() => db.close());
 for (const id of ['owner', 'other']) db.prepare('INSERT INTO user(id,name,email) VALUES(?,?,?)').run(id, id, id+'@example.test');
 const key=Buffer.alloc(32,7); let user='owner';
 const app=createBankAccountsRouter({database:db,getUserId:async()=>user,getEncryptionKey:()=>key,now:()=>new Date('2026-11-12T12:00:00Z')});
 const send=(path,body,headers={})=>app.request(path,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});
 const create=async(type='investment')=>{const r=await send('/',{name:'Brokerage',institutionName:'Broker',type,subtype:'brokerage',currencyCode:'USD'});assert.equal(r.status,201);return (await r.json()).account;};
 const raw=id=>JSON.parse(decryptBankValue(db.prepare('SELECT encrypted_data FROM bank_account WHERE id=?').get(id).encrypted_data,key));
 return {db,key,app,send,create,raw,setUser:value=>{user=value;}};
}
const holding=(extra={})=>({symbol:'VTI',name:'Total market',quantity:1.2345,price:10.1234,marketValue:99.99,costBasis:null,isCash:false,...extra});
const input=(extra={})=>({valuationDate:'2026-11-10',source:'Statement',accountValue:120,cashBalance:10,holdings:[holding()],...extra});
const path=a=>'/'+a.id+'/investments';
const csv='symbol,name,quantity,price,marketValue,costBasis,isCash\r\nVTI,"Total, ""market""",,,99.99,,false\r\n';

test('snapshots round-trip exact source values encrypted, with no mutation on GET',async t=>{
 const f=fixture(t),a=await f.create(),r=await f.send(path(a),{snapshot:input()});assert.equal(r.status,201);
 const saved=(await r.json()).snapshot;assert.deepEqual({...saved,id:undefined,createdAt:undefined},{...input(),id:undefined,createdAt:undefined});assert.equal(typeof saved.id,'string');assert.ok(!Number.isNaN(Date.parse(saved.createdAt)));
 const before=f.db.serialize(),read=await f.app.request(path(a));assert.equal(read.status,200);assert.equal(read.headers.get('cache-control'),'no-store');assert.deepEqual(await read.json(),{snapshots:[saved]});assert.deepEqual(f.db.serialize(),before);
 const row=f.db.prepare('SELECT * FROM investment_snapshot').get();assert.deepEqual(JSON.parse(decryptBankValue(row.encrypted_data,f.key)),input());
 for(const secret of ['Total market','Statement','2026-11-10','99.99','balanceReference'])assert.ok(!f.db.serialize().includes(Buffer.from(secret)),secret);
 assert.deepEqual(f.raw(a.id).balanceReference,{amount:120,date:'2026-11-10',verified:true});
});

test('older snapshots stay immutable and never override current; same-date newest wins',async t=>{
 const f=fixture(t),a=await f.create();
 const save=async snapshot=>{const r=await f.send(path(a),{snapshot});assert.equal(r.status,201);return(await r.json()).snapshot;};
 const first=await save(input());const original=f.db.prepare('SELECT encrypted_data FROM investment_snapshot WHERE id=?').get(first.id).encrypted_data;
 const older=await save(input({valuationDate:'2026-10-01',accountValue:1}));assert.equal(f.raw(a.id).currentBalance,120);
 const next=await save(input({accountValue:140}));assert.equal(f.raw(a.id).currentBalance,140);assert.ok(next.createdAt>first.createdAt,'fixed-clock same-date writes must have deterministic latest ordering');
 assert.deepEqual((await(await f.app.request(path(a))).json()).snapshots.map(s=>s.id),[next.id,first.id,older.id]);
 assert.equal(f.db.prepare('SELECT encrypted_data FROM investment_snapshot WHERE id=?').get(first.id).encrypted_data,original);
 assert.throws(()=>f.db.prepare('UPDATE investment_snapshot SET encrypted_data=? WHERE id=?').run('changed',first.id));
 assert.equal((await f.app.request(path(a)+'/'+first.id,{method:'DELETE'})).status,404);
 assert.equal((await(await f.app.request('/')).json()).accounts.find(x=>x.id===a.id).currentBalance,140);
});

test('preview parses quoted CSV, preserves unknowns and discrepancies without any writes',async t=>{
 const f=fixture(t),a=await f.create(),before=f.db.serialize();
 const {holdings,...fields}=input();const r=await f.send(path(a)+'/preview',{...fields,csv});assert.equal(r.status,200);
 const result=(await r.json()).snapshot;assert.deepEqual(result,{...fields,holdings:[holding({name:'Total, "market"',quantity:null,price:null})]});assert.deepEqual(f.db.serialize(),before);
 assert.equal((await f.send(path(a),{snapshot:result})).status,201);
 assert.deepEqual((await(await f.app.request(path(a))).json()).snapshots[0].holdings,result.holdings);
});

test('authentication and owner isolation apply to reads, saves and previews',async t=>{
 const f=fixture(t),a=await f.create();await f.send(path(a),{snapshot:input()});
 for(const [user,status] of [[null,401],['other',404]]){f.setUser(user);const before=f.db.serialize();assert.equal((await f.app.request(path(a))).status,status);assert.equal((await f.send(path(a),{snapshot:input()})).status,status);assert.equal((await f.send(path(a)+'/preview',{...input(),csv})).status,status);assert.deepEqual(f.db.serialize(),before);}
});

test('only active nonlegacy investments read; only manual investments write',async t=>{
 const f=fixture(t),a=await f.create(),cash=await f.create('depository');
 for(const suffix of ['', '/preview'])assert.equal((await f.send(path(cash)+suffix,suffix?{...input(),csv}:{snapshot:input()})).status,409);
 assert.equal((await f.app.request(path(cash))).status,409);
 f.db.prepare("UPDATE bank_item SET provider='imported' WHERE item_id=?").run(a.itemId);
 assert.equal((await f.app.request(path(a))).status,200);
 for(const suffix of ['', '/preview'])assert.equal((await f.send(path(a)+suffix,suffix?{...input(),csv}:{snapshot:input()})).status,409);
 f.db.prepare("UPDATE bank_item SET provider='legacy' WHERE item_id=?").run(a.itemId);assert.equal((await f.app.request(path(a))).status,404);
 f.db.prepare("UPDATE bank_item SET provider='manual' WHERE item_id=?").run(a.itemId);f.db.prepare('UPDATE bank_account SET is_active=0 WHERE id=?').run(a.id);assert.equal((await f.send(path(a),{snapshot:input()})).status,404);
});

test('real nonfuture dates, bounded strings/counts, malformed objects and unknown fields reject',async t=>{
 const f=fixture(t),a=await f.create();
 const invalid=[null,[],{},input({valuationDate:'2026-02-29'}),input({valuationDate:'2026-11-13'}),input({valuationDate:'2026-1-01'}),input({source:'x'.repeat(201)}),input({source:''}),input({holdings:Array(1001).fill(holding())}),input({holdings:[null]}),input({holdings:[holding({symbol:'x'.repeat(101)})]}),input({holdings:[holding({name:'x'.repeat(201)})]}),input({holdings:[holding({isCash:'false'})]}),input({extra:true}),input({holdings:[holding({extra:true})]})];
 const before=f.db.serialize();for(const snapshot of invalid)assert.equal((await f.send(path(a),{snapshot})).status,400,JSON.stringify(snapshot)?.slice(0,150));assert.deepEqual(f.db.serialize(),before);
 assert.equal((await f.send(path(a),{snapshot:input({valuationDate:'2024-02-29',holdings:[]})})).status,201);
});

test('safe cents for money; finite nonnegative bounded fractional quantities and prices',async t=>{
 const f=fixture(t),a=await f.create();
 for(const field of ['accountValue','cashBalance'])for(const value of [-1,null,'1',0.001,1e12+0.01,1e100])assert.equal((await f.send(path(a),{snapshot:input({[field]:value})})).status,400,field+':'+value);
 for(const field of ['marketValue','costBasis','quantity','price'])for(const value of [-1,'1',1e100])assert.equal((await f.send(path(a),{snapshot:input({holdings:[holding({[field]:value})]})})).status,400,field+':'+value);
 for(const field of ['marketValue','costBasis'])assert.equal((await f.send(path(a),{snapshot:input({holdings:[holding({[field]:0.001})]})})).status,400);
 assert.equal((await f.send(path(a),{snapshot:input({accountValue:1e12,holdings:[holding({quantity:null,price:null,costBasis:null})]})})).status,201);
 const raw=JSON.stringify({snapshot:input()}).replace('120','1e999');assert.equal((await f.app.request(path(a),{method:'POST',headers:{'content-type':'application/json'},body:raw})).status,400);
});

test('aggregate market value plus separate cash and aggregate known basis stay within safe cents',async t=>{
 const f=fixture(t),a=await f.create();
 for(const snapshot of [input({cashBalance:0,holdings:[holding({marketValue:1e12}),holding({marketValue:0.01})]}),input({cashBalance:0.01,holdings:[holding({marketValue:1e12})]}),input({holdings:[holding({costBasis:1e12}),holding({costBasis:0.01})]})])assert.equal((await f.send(path(a),{snapshot})).status,400);
 assert.equal((await f.send(path(a),{snapshot:input({cashBalance:0.01,holdings:[holding({marketValue:999999999999.99})]})})).status,201);
});

test('cash holdings require zero separate cash balance, no implicit reconciliation',async t=>{
 const f=fixture(t),a=await f.create();const holdings=[holding({symbol:'CORE',isCash:true,marketValue:20})];
 assert.equal((await f.send(path(a),{snapshot:input({holdings})})).status,400);
 const r=await f.send(path(a),{snapshot:input({cashBalance:0,holdings})});assert.equal(r.status,201);assert.equal((await r.json()).snapshot.accountValue,120);
});

test('CSV rejects malformed quoting, headers, missing booleans, numeric junk and excess rows',async t=>{
 const f=fixture(t),a=await f.create(); const {holdings,...fields}=input();
 for(const value of ['x,y\na,b',csv.replace('false',''),csv.replace('false','TRUE'),csv.replace('99.99','12oops'),csv.replace('99.99','Infinity'),csv.replace('99.99','-1'),csv.replace('"Total, ""market"""','"unterminated'),csv.replace('VTI,','VTI"bad,'),csv+'extra,row',csv.split('\r\n')[0]+'\n'+Array(1001).fill('VTI,Fund,,,1,,false').join('\n')])assert.equal((await f.send(path(a)+'/preview',{...fields,csv:value})).status,400,value.slice(0,100));
});

test('JSON/origin checks and actual bounded streamed body run through shared router guard',async t=>{
 const f=fixture(t),a=await f.create();
 for(const suffix of ['', '/preview']){
 const body=suffix?{...input(),csv}:{snapshot:input()};
 assert.equal((await f.send(path(a)+suffix,body,{origin:'https://evil.test'})).status,403);
 assert.equal((await f.send(path(a)+suffix,body,{'sec-fetch-site':'cross-site'})).status,403);
 assert.equal((await f.send(path(a)+suffix,body,{'content-type':'text/plain'})).status,400);
 const response=await f.app.request(path(a)+suffix,{method:'POST',headers:{'content-type':'application/json'},body:new ReadableStream({start(c){for(let i=0;i<6;i++)c.enqueue(new Uint8Array(1024*1024));c.close();}}),duplex:'half'});assert.equal(response.status,413);
 }
 assert.equal((await f.app.request(path(a),{method:'POST',headers:{'content-type':'application/json'},body:'{'})).status,400);
});

test('latest writes invalidate net worth atomically; failures roll back with safe errors',async t=>{
 const f=fixture(t),a=await f.create();await f.app.request('/net-worth');assert.equal(f.db.prepare('SELECT count(*) n FROM net_worth_history_cache').get().n,1);
 await f.send(path(a),{snapshot:input()});assert.equal(f.db.prepare('SELECT count(*) n FROM net_worth_history_cache').get().n,0);
 await f.app.request('/net-worth');await f.send(path(a),{snapshot:input({valuationDate:'2026-10-01'})});assert.equal(f.db.prepare('SELECT count(*) n FROM net_worth_history_cache').get().n,1);
 f.db.exec("CREATE TRIGGER fail_snapshot_balance BEFORE UPDATE ON bank_account BEGIN SELECT RAISE(ABORT,'private SQL failure'); END");const before=f.db.serialize();const r=await f.send(path(a),{snapshot:input({valuationDate:'2026-11-11'})});assert.equal(r.status,500);assert.doesNotMatch(await r.text(),/private|SQL|Error:/);assert.deepEqual(f.db.serialize(),before);
});

test('snapshot ownership is enforced by foreign keys and owner deletion cascades',async t=>{
 const f=fixture(t),a=await f.create();await f.send(path(a),{snapshot:input()});
 assert.throws(()=>f.db.prepare('INSERT INTO investment_snapshot(id,account_id,user_id,created_at,encrypted_data) VALUES(?,?,?,?,?)').run('wrong',a.id,'other','2026-11-12T12:00:00Z',encryptBankValue('{}',f.key)));
 f.db.prepare('DELETE FROM user WHERE id=?').run('owner');assert.equal(f.db.prepare('SELECT count(*) n FROM investment_snapshot').get().n,0);
});
