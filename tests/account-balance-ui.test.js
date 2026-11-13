import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { renderManualAccountDialog, renderImportDialog } from '../src/account-import.ts';
import { renderAccountDetail, renderAccounts, getTotalBalance } from '../src/bank_accounts.ts';

const account = { id:'manual',itemId:'item',name:'Checking',institutionName:'Bank',type:'depository',subtype:'checking',mask:'1234',officialName:null,currentBalance:2400,availableBalance:null,currencyCode:'USD',source:'manual',canImport:true,updatedAt:'2026-11-12T00:00:00Z',balanceReference:{amount:2400,date:'2026-11-10',verified:true} };

test('creation uses a default zero and only the two simple closing-balance fields', () => {
 const html=renderManualAccountDialog();
 assert.match(html,/name="currentBalance"[^>]*value="0.00"[^>]*required/);
 assert.match(html,/class="account-form-grid balance-reference-fields"/);
 assert.match(html,/End of day/);
 assert.match(html,/name="balanceDate"[^>]*type="date"[^>]*required/);
 assert.match(html,/You can adjust the balance after importing transactions\./);
 assert.doesNotMatch(html,/type="radio"|Current balance \(optional\)|manual snapshot|not changed by transaction imports/);
});

test('manual account details expose repair and adjustment without a fake available balance', () => {
 const html=renderAccountDetail(account,[]);
 assert.match(html,/id="set-account-balance"/);
 assert.match(html,/id="account-balance-dialog"/);
 assert.match(html,/End of day/);
 assert.match(html,/2026-11-10/);
 assert.doesNotMatch(html,/Available balance/);
 assert.match(renderAccountDetail({...account,currentBalance:null,balanceReference:undefined},[]),/Balance not set/);
 assert.match(renderAccounts([{...account,currentBalance:0,balanceReference:{amount:0,date:'2026-11-12',verified:false}}]),/Default balance/);
 const saved=renderAccountDetail({...account,source:'saved',canImport:false,balanceReference:undefined},[]);
 assert.doesNotMatch(saved,/id="set-account-balance"|id="account-balance-dialog"/);
 assert.match(saved,/Available balance/);
});

test('single import preview contains a real balance calculation slot, not fixed-snapshot claims', () => {
 const html=renderImportDialog(account);
 assert.match(html,/id="import-balance-impact"/);
 assert.doesNotMatch(html,/Your account balance will not change/);
});

test('manual balance options and reference share a single current-balance panel', () => {
 const html=renderAccountDetail(account,[]);
 assert.match(html,/account-detail-balances account-detail-balances-manual/);
 assert.match(html,/id="account-balance-options"[^>]*aria-label="Balance options"[^>]*popovertarget="account-balance-menu"/);
 assert.match(html,/id="account-balance-menu"[^>]*popover="auto"/);
 assert.match(html,/class="account-balance-reference"/);
 assert.doesNotMatch(html,/account-balance-controls/);
 const saved=renderAccountDetail({...account,source:'saved',canImport:false},[]);
 assert.doesNotMatch(saved,/id="account-balance-options"|id="account-balance-menu"/);
});

test('a credit overpayment is an asset, not more debt', () => {
 const overpaid = { ...account, type: 'credit', currentBalance: -50 };
 assert.equal(getTotalBalance([overpaid]),50);
 assert.match(renderAccountDetail(overpaid,[]),/<strong>\$50.00<\/strong>/);
 assert.doesNotMatch(renderAccounts([overpaid]),/liability-balance/);
 assert.doesNotMatch(renderAccountDetail({...overpaid,currentBalance:0},[]),/-\$0.00/);
});

test('balance fields follow the app 800px mobile breakpoint', () => {
 const css=readFileSync(new URL('../src/style.css',import.meta.url),'utf8');
 assert.match(css,/@media\s*\(max-width:\s*800px\)\s*\{[^}]*\.balance-reference-fields[^}]*grid-template-columns:\s*1fr/);
});
