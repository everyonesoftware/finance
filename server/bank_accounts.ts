import { createHash, randomBytes } from "node:crypto";
import { Hono, type Context } from "hono";
import type Database from "better-sqlite3";
import { decryptBankValue, encryptBankValue, getBankEncryptionKey } from "./bank-crypto.js";
import { listAccountTransactions, listAllUserTransactions, refreshBankAccountSnapshots } from "./account-storage.js";
import { getRecentTransactions } from "./transaction-sync.js";
import { fetchTellerAccounts, fetchTellerTransactions, parseEnrollment, tellerRequest, validateTellerSettings, verifyEnrollmentSignature, TellerConfigurationError, TellerDataError, type TellerAccount, type TellerSettings, type TellerTransport } from "./teller.js";

export interface BankRouterDependencies {
 database: Database.Database;
 getUserId: (context: Context) => Promise<string | null>;
 getSettings: (userId: string) => TellerSettings | null | Promise<TellerSettings | null>;
 getEncryptionKey: () => Buffer;
 transport?: TellerTransport;
 now?: () => number;
 getSessionBinding?: (context: Context) => string | Promise<string>;
}
interface Item {
 item_id: string; user_id: string; provider: string;
 provider_application_id: string | null; provider_environment: string | null; provider_user_id: string | null;
 encrypted_access_token: string; encrypted_institution_name: string; updated_at: number;
}
class OwnershipError extends Error {}
const hash=(s:string):string=>createHash("sha256").update(s).digest("hex");
function trustedOrigin(origin:string|undefined):boolean {
 if(!origin) return false;
 try {return ["http://localhost:5173","http://127.0.0.1:5173",...(process.env["ORIGIN_URL"]?[new URL(process.env["ORIGIN_URL"]!).origin]:[])].includes(new URL(origin).origin);} catch {return false;}
}
export function createBankAccountsRouter(deps:BankRouterDependencies):Hono {
 const router=new Hono(),db=deps.database,transport=deps.transport??tellerRequest,now=deps.now??Date.now,key=deps.getEncryptionKey;
 const userIds=new WeakMap<Request,string>();
 const settingsFor=async(u:string,required=true):Promise<TellerSettings|null>=>{const s=await deps.getSettings(u);if(s) {try {validateTellerSettings(s);} catch(e) {if(required) throw e;return null;}}return s;};
 const itemsFor=(u:string):Item[]=>db.prepare("SELECT * FROM bank_item WHERE user_id=? AND provider='teller'").all(u) as Item[];
 function checkBinding(i:Item,s:TellerSettings):void {if(i.provider!=="teller"||i.provider_application_id!==s.applicationId||i.provider_environment!==s.environment) throw new OwnershipError();}
 function assertOwner(id:string,u:string,s:TellerSettings,providerUser?:string):void {
  const i=db.prepare("SELECT * FROM bank_item WHERE item_id=?").get(id) as Item|undefined;
  if(i) {if(i.user_id!==u||(providerUser&&i.provider_user_id!==providerUser)) throw new OwnershipError();checkBinding(i,s);}
 }
 function assertAccounts(accounts:TellerAccount[],id:string,u:string,s:TellerSettings):void {
  for(const a of accounts) {
   const rows=db.prepare("SELECT i.* FROM bank_account a JOIN bank_item i ON i.item_id=a.item_id WHERE a.provider_account_id=? AND i.provider='teller' AND i.provider_application_id=? AND i.provider_environment=?").all(a.id,s.applicationId,s.environment) as Item[];
   if(rows.some(i=>i.item_id!==id||i.user_id!==u)) throw new OwnershipError();
  }
 }
 function accountsFor(u:string):Array<Record<string,unknown>> {
  const rows=db.prepare("SELECT a.*,i.encrypted_institution_name,i.updated_at AS retrieved_at FROM bank_account a JOIN bank_item i ON i.item_id=a.item_id AND i.user_id=a.user_id WHERE a.user_id=? AND a.is_active=1 AND i.provider='teller'").all(u) as Array<{id:string;item_id:string;provider_account_id:string;encrypted_data:string;encrypted_institution_name:string;updated_at:number;retrieved_at:number}>;
  if(!rows.length) return [];const k=key();
  return rows.map(r=>({...JSON.parse(decryptBankValue(r.encrypted_data,k)),id:r.id,itemId:r.item_id,providerAccountId:r.provider_account_id,institutionName:decryptBankValue(r.encrypted_institution_name,k),updatedAt:new Date(r.updated_at*1000).toISOString(),lastRetrievedAt:new Date(r.retrieved_at*1000).toISOString()}));
 }
 function saveSnapshots(accounts:TellerAccount[],id:string,u:string,k:Buffer):void {
  refreshBankAccountSnapshots(db,id,u,accounts.filter(a=>!a.closed).map(a=>({providerAccountId:a.id,encryptedData:encryptBankValue(JSON.stringify(a.snapshot),k)})));
 }
 async function sync(i:Item,u:string,s:TellerSettings):Promise<void> {
  checkBinding(i,s);const k=key(),token=decryptBankValue(i.encrypted_access_token,k);
  const accounts=await fetchTellerAccounts(s,token,i.item_id,transport);assertAccounts(accounts,i.item_id,u,s);
  const transactions:Array<Record<string,unknown>>=[];
  for(const a of accounts) if(!a.closed) {transactions.push(...await fetchTellerTransactions(s,token,a,transport));if(transactions.length>100000) throw new TellerDataError("Enrollment transaction limit exceeded.");}
  // Stage all pages and balances before replacing this enrollment's snapshot atomically.
  db.transaction(()=>{
   assertOwner(i.item_id,u,s);const current=db.prepare("SELECT encrypted_access_token FROM bank_item WHERE item_id=? AND user_id=? AND provider='teller'").get(i.item_id,u) as {encrypted_access_token:string}|undefined;
   if(!current||current.encrypted_access_token!==i.encrypted_access_token) throw new OwnershipError();
   assertAccounts(accounts,i.item_id,u,s);saveSnapshots(accounts,i.item_id,u,k);
   db.prepare("DELETE FROM bank_transaction WHERE item_id=? AND user_id=?").run(i.item_id,u);
   const insert=db.prepare("INSERT INTO bank_transaction(transaction_id,item_id,user_id,account_id,encrypted_data) VALUES(?,?,?,?,?)");
   for(const tx of transactions) insert.run(tx.transaction_id,i.item_id,u,tx.account_id,encryptBankValue(JSON.stringify(tx),k));
   db.prepare("UPDATE bank_item SET encrypted_transaction_cursor=NULL,updated_at=unixepoch() WHERE item_id=? AND user_id=? AND provider='teller'").run(i.item_id,u);
  })();
 }
 const binding=async(c:Context,u:string):Promise<string>=>hash(deps.getSessionBinding?await deps.getSessionBinding(c):(c.req.header("cookie")??c.req.header("authorization")??u));
 router.use("*",async(c,next)=>{
  c.header("Cache-Control","no-store");
  if(c.req.method!=="GET"&&!trustedOrigin(c.req.header("origin"))) return c.json({error:"Request origin is not allowed."},403);
  const u=await deps.getUserId(c);if(!u) return c.json({error:"Authentication required."},401);userIds.set(c.req.raw,u);await next();
 });
 router.onError((e,c)=>{
  // Do not serialize errors: remote and TLS failures can contain tokens and keys.
  if(e instanceof TellerConfigurationError) return c.json({error:"Teller is not configured. Check Settings."},503);
  if(e instanceof OwnershipError) return c.json({error:"Bank connection ownership or configuration does not match."},409);
  if(e instanceof TellerDataError) return c.json({error:"Invalid bank data or enrollment."},400);
  return c.json({error:"Unable to complete the bank operation. Please retry."},c.req.method==="GET"?500:502);
 });
 const uid=(c:Context):string=>userIds.get(c.req.raw)!;
 router.post("/connect-config",async(c)=>{
  const u=uid(c),s=await settingsFor(u);if(!s) throw new TellerConfigurationError();
  db.prepare("DELETE FROM bank_connect_nonce WHERE expires_at<=?").run(Math.floor(now()/1000));
  if((db.prepare("SELECT count(*) n FROM bank_connect_nonce WHERE user_id=?").get(u) as {n:number}).n>=20) return c.json({error:"Too many pending connection attempts."},429);
  const nonce=randomBytes(32).toString("hex");
  db.prepare("INSERT INTO bank_connect_nonce(nonce_hash,user_id,session_binding,application_id,environment,expires_at) VALUES(?,?,?,?,?,?)").run(hash(nonce),u,await binding(c,u),s.applicationId,s.environment,Math.floor(now()/1000)+300);
  return c.json({applicationId:s.applicationId,environment:s.environment,products:["balance","transactions"],nonce});
 });
 router.post("/enroll",async(c)=>{
  const u=uid(c),s=await settingsFor(u);if(!s) throw new TellerConfigurationError();
  const reader=c.req.raw.body?.getReader(),chunks:Uint8Array[]=[];let size=0;
  if(reader) try {
   for(;;) {const chunk=await reader.read();if(chunk.done) break;size+=chunk.value.byteLength;
    if(size>16384) {await reader.cancel();return c.json({error:"Enrollment body is too large."},413);}chunks.push(chunk.value);}
  } finally {reader.releaseLock();}
  const text=Buffer.concat(chunks).toString("utf8");
  let body:unknown;try{body=JSON.parse(text);}catch{return c.json({error:"A valid JSON body is required."},400);}
  const e=parseEnrollment(body);
  const used=db.prepare("DELETE FROM bank_connect_nonce WHERE nonce_hash=? AND user_id=? AND session_binding=? AND application_id=? AND environment=? AND expires_at>?").run(hash(e.nonce),u,await binding(c,u),s.applicationId,s.environment,Math.floor(now()/1000));
  if(used.changes!==1) return c.json({error:"Connection attempt has expired or was already used."},400);
  if(!verifyEnrollmentSignature(e,s)) return c.json({error:"Invalid enrollment signature."},400);
  if(s.environment==="sandbox"&&!e.accessToken.startsWith("test_")) return c.json({error:"A sandbox token is required."},400);
  assertOwner(e.enrollment.id,u,s,e.user.id);const k=key();
  for(const i of db.prepare("SELECT * FROM bank_item WHERE provider='teller'").all() as Item[]) if(decryptBankValue(i.encrypted_access_token,k)===e.accessToken&&(i.item_id!==e.enrollment.id||i.user_id!==u||i.provider_application_id!==s.applicationId||i.provider_environment!==s.environment)) throw new OwnershipError();
  const accounts=await fetchTellerAccounts(s,e.accessToken,e.enrollment.id,transport);assertAccounts(accounts,e.enrollment.id,u,s);
  db.transaction(()=>{
   assertOwner(e.enrollment.id,u,s,e.user.id);assertAccounts(accounts,e.enrollment.id,u,s);
   db.prepare("INSERT INTO bank_item(item_id,user_id,provider,provider_application_id,provider_environment,provider_user_id,institution_id,encrypted_institution_name,encrypted_access_token) VALUES(?,?,'teller',?,?,?,?,?,?) ON CONFLICT(item_id) DO UPDATE SET encrypted_institution_name=excluded.encrypted_institution_name,encrypted_access_token=excluded.encrypted_access_token,institution_id=excluded.institution_id,updated_at=unixepoch()").run(e.enrollment.id,u,s.applicationId,s.environment,e.user.id,accounts[0]?.institutionId??null,encryptBankValue(accounts[0]?.institutionName??e.enrollment.institution.name,k),encryptBankValue(e.accessToken,k));
   saveSnapshots(accounts,e.enrollment.id,u,k);
  })();return c.json({accounts:accountsFor(u)});
 });
 router.get("/",async(c)=>c.json({configured:(await settingsFor(uid(c),false))!==null,accounts:accountsFor(uid(c))}));
 router.get("/items",async(c)=>{
  const u=uid(c),accounts=accountsFor(u),items=itemsFor(u);
  return c.json({configured:(await settingsFor(u,false))!==null,connections:items.map(i=>({itemId:i.item_id,institutionName:decryptBankValue(i.encrypted_institution_name,key()),lastRetrievedAt:new Date(i.updated_at*1000).toISOString(),accountCount:accounts.filter(a=>a.itemId===i.item_id).length,accounts:accounts.filter(a=>a.itemId===i.item_id)}))});
 });
 for(const path of ["/transactions","/transactions/all"]) router.get(path,async(c)=>{
  const u=uid(c),s=await settingsFor(u,false),transactions=listAllUserTransactions(db,u,key());
  return c.json({transactions:path.endsWith("/all")?transactions:getRecentTransactions(transactions),accounts:accountsFor(u),configured:s!==null});
 });
 router.get("/:accountId/transactions",async(c)=>{
  const u=uid(c),accounts=accountsFor(u),account=accounts.find(a=>a.id===c.req.param("accountId"));if(!account) return c.json({error:"Account not found."},404);
  return c.json({account,transactions:listAccountTransactions(db,u,account.itemId as string,account.providerAccountId as string,key()),accounts});
 });
 router.post("/transactions/sync",async(c)=>{
  const u=uid(c),s=await settingsFor(u);if(!s) throw new TellerConfigurationError();for(const i of itemsFor(u)) await sync(i,u,s);
  return c.json({transactions:getRecentTransactions(listAllUserTransactions(db,u,key()))});
 });
 router.post("/items/:itemId/transactions/sync",async(c)=>{
  const u=uid(c),i=itemsFor(u).find(i=>i.item_id===c.req.param("itemId"));if(!i) return c.json({error:"Bank connection not found."},404);
  const s=await settingsFor(u);if(!s) throw new TellerConfigurationError();try {await sync(i,u,s);}catch(e){if(e instanceof OwnershipError) throw e;return c.json({error:"Unable to sync this institution. Please retry."},502);}return c.json({synced:true});
 });
 router.delete("/items/:itemId",async(c)=>{
  const u=uid(c),i=itemsFor(u).find(i=>i.item_id===c.req.param("itemId"));if(!i) return c.json({error:"Bank connection not found."},404);
  const s=await settingsFor(u);if(!s) throw new TellerConfigurationError();checkBinding(i,s);
  // Teller's single enrollment-wide removal avoids partial per-account deletion.
  await transport(s,decryptBankValue(i.encrypted_access_token,key()),"DELETE","/accounts");
  db.prepare("DELETE FROM bank_item WHERE item_id=? AND user_id=? AND provider='teller' AND encrypted_access_token=?").run(i.item_id,u,i.encrypted_access_token);return c.body(null,204);
 });return router;
}
// Lazy defaults avoid process-global database/auth state in isolated fixtures.
export const bankAccountsRouter:Hono=new Hono();let defaultRouter:Hono|undefined;
bankAccountsRouter.all("*",async(c)=>{
 if(!defaultRouter){const [{sqliteClient},{auth},{getTellerSettings}]=await Promise.all([import("./database.js"),import("./auth.js"),import("./teller-settings.js")]);
 defaultRouter=createBankAccountsRouter({database:sqliteClient,getUserId:async(c)=>(await auth.api.getSession({headers:c.req.raw.headers}))?.user.id??null,getSessionBinding:async(c)=>(await auth.api.getSession({headers:c.req.raw.headers}))?.session.id??"",getSettings:getTellerSettings,getEncryptionKey:getBankEncryptionKey});}
 // Hono preserves the mounted prefix in raw URLs; the isolated router uses relative paths.
 const url=new URL(c.req.url),prefix=c.req.routePath.replace(/\*$/, "").replace(/\/$/, "");
 url.pathname=url.pathname.slice(prefix.length)||"/";
 return defaultRouter.fetch(new Request(url,c.req.raw));
});
