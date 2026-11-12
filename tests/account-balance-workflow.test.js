import assert from 'node:assert/strict';
import test from 'node:test';
import { renderBalanceImpact, renderBalanceFields, renderAccountBalanceDialog, localBalanceDate, initializeAccountBalance } from '../src/account-balance.ts';

const impact={referenceBalance:2400,referenceDate:'2026-11-10',startingBalance:2500,historicalCount:3,appliedCount:2,appliedAmount:350,duplicates:1,balanceAfterImport:2850,canApply:true};
test('balance calculation shows reference, existing activity, fresh impact and final balance',()=>{
 const html=renderBalanceImpact(impact,'USD','<Checking>');
 for(const text of ['Balance after import','2,400.00','100.00','350.00','2,850.00','Already included','Skipped','&lt;Checking&gt;'])assert.ok(html.includes(text),text);
 assert.doesNotMatch(html,/<Checking>/);
 assert.match(renderBalanceImpact({...impact,startingBalance:null,balanceAfterImport:null,referenceDate:null,referenceBalance:null,canApply:false,reason:'Set a known balance first.'},'USD'),/Set a known balance first/);
 assert.doesNotMatch(renderBalanceImpact({...impact,startingBalance:null,balanceAfterImport:null,canApply:false},'USD'),/NaN/);
});
test('simple shared fields escape values and label credit balances as amount owed',()=>{
 const html=renderBalanceFields('USD',0,'2026-11-12');
 assert.match(html,/value="0.00"/);assert.match(html,/End of day/);assert.doesNotMatch(html,/radio/);
 assert.match(renderBalanceFields('<bad>',12,'2026-11-12',true),/Amount owed \(&lt;bad&gt;\)/);
});
test('adjusting a balance starts from the current value and today, not an old reference',()=>{
 const html=renderAccountBalanceDialog({name:'Checking',currencyCode:'USD',type:'depository',currentBalance:2750,balanceReference:{amount:2400,date:'2026-01-01',verified:true}});
 assert.match(html,/name="currentBalance"[^>]*value="2750.00"/);
 assert.ok(html.includes(`value="${localBalanceDate()}"`));
 assert.doesNotMatch(html,/value="2400.00"|value="2026-01-01"/);
});

class Element {
 handlers={};isConnected=true;hidden=false;open=false;disabled=false;textContent='';
 addEventListener(event,fn){(this.handlers[event]??=[]).push(fn);}
 async emit(event){for(const fn of this.handlers[event]??[])await fn({preventDefault(){},target:this});}
 querySelectorAll(){return [];}
 showModal(){this.open=true;}
 close(){this.open=false;}
}
for(const departure of ['abort','detach','none'])test(`balance save is scoped during ${departure}`,async t=>{
 const selectors=['#account-balance-dialog','#account-balance-form','#account-balance-error','#cancel-account-balance','#save-account-balance','#set-account-balance'];
 const nodes=Object.fromEntries(selectors.map(id=>[id,new Element()]));
 const previous=globalThis.document,Form=globalThis.FormData;
 globalThis.document={querySelector:id=>nodes[id]??null};
 globalThis.FormData=class{get(name){return name==='currentBalance'?'2400.00':'2026-11-10';}};
 t.after(()=>{globalThis.document=previous;globalThis.FormData=Form;});
 const calls=[];let complete;const pending=new Promise(resolve=>complete=resolve);
 t.mock.method(globalThis,'fetch',(url,options)=>{calls.push([url,options]);return pending;});
 let callbacks=0;const controller=new AbortController();
 initializeAccountBalance({id:'private/id'},async()=>callbacks++,controller.signal);
 await nodes['#set-account-balance'].emit('click');
 const running=nodes['#account-balance-form'].emit('submit');
 assert.equal(nodes['#save-account-balance'].disabled,true);
 await nodes['#account-balance-form'].emit('submit');
 assert.equal(calls.length,1,'busy forms cannot double-submit');
 assert.equal(calls[0][1].method,'PATCH');
 assert.equal(calls[0][0],'/api/accounts/private%2Fid/balance');
 assert.deepEqual(JSON.parse(calls[0][1].body),{currentBalance:2400,balanceDate:'2026-11-10'});
 if(departure==='abort')controller.abort();
 if(departure==='detach')nodes['#account-balance-dialog'].isConnected=false;
 complete({ok:true,json:async()=>({account:{id:'private/id'}})});await running;
 assert.equal(callbacks,departure==='none'?1:0);
 if(departure==='none')assert.equal(nodes['#account-balance-dialog'].open,false);
 else {
  await nodes['#account-balance-form'].emit('submit');
  assert.equal(calls.length,1,'departed forms cannot start another write');
 }
});
