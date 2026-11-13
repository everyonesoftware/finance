import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderInvestmentDetail, investmentTotals, investmentIncome, renderInvestmentSummary, renderInvestmentHoldings, renderInvestmentActivity, renderInvestmentIncome } from '../src/investments.ts';
import { renderAccountDetail } from '../src/bank_accounts.ts';

const account = { id:'broker',itemId:'manual',name:'Brokerage',institutionName:'Broker',type:'investment',subtype:null,mask:null,officialName:null,currentBalance:999,currencyCode:'USD',availableBalance:null,source:'manual',canImport:true,updatedAt:'2026-11-12' };
const snapshot = { id:'snapshot',createdAt:'2026-11-12T00:00:00Z',valuationDate:'2026-11-10',source:'Statement <verified>',accountValue:110,cashBalance:10,holdings:[{symbol:'AAA',name:'Example',quantity:2,price:40,marketValue:80,costBasis:null,isCash:false},{symbol:'CORE',name:'Core cash',quantity:20,price:1,marketValue:20,costBasis:20,isCash:true}] };
const income = (amount,distribution='unknown',extra={}) => ({amount,iso_currency_code:'USD',name:'Distribution',date:'2026-11-10',investmentActivity:{kind:'income',symbol:'AAA',quantity:null,price:null,distribution},...extra});

test('snapshot totals count cash once and preserve unknown basis', () => {
 assert.deepEqual(investmentTotals(snapshot),{invested:80,coreCash:30,total:110,difference:0});
 const html=renderInvestmentHoldings(account,snapshot);
 assert.match(html,/Not supplied/);
 assert.doesNotMatch(html,/\$0.00/);
 assert.match(html,/72.73%/);
 assert.doesNotMatch(renderInvestmentHoldings(account,{...snapshot,accountValue:0}),/Infinity|NaN/);
});
test('snapshot source value is distinct from manual balance; differences remain visible',()=>{
 const html=renderInvestmentSummary(account,{...snapshot,accountValue:115});
 assert.match(html,/\$115.00/);assert.match(html,/\$999.00/);assert.match(html,/\$5.00/);
 assert.match(html,/Statement &lt;verified&gt;/);assert.match(html,/2026-11-10/);
 assert.doesNotMatch(html,/YTD|Annualized|Total return/);
});
test('income nets reversals in cents and excludes pending, foreign, unknown currency and legacy',()=>{
 const tx=[income(-10.01),income(2.03),income(-3,'reinvested'),income(-4,'cash'),income(-999,'cash',{pending:true}),income(-999,'cash',{iso_currency_code:'EUR'}),income(-999,'cash',{iso_currency_code:null}),{amount:-500,name:'DIVIDEND RECEIVED'},income(-8,'unknown',{investmentActivity:{kind:'trade',distribution:'reinvested'}})];
 assert.deepEqual(investmentIncome(account,tx),{total:1498,cash:400,reinvested:300,unknown:798,count:4,excluded:5});
 const html=renderInvestmentIncome(account,tx);
 assert.match(html,/\$14.98/);assert.match(html,/Unknown treatment/);assert.match(html,/Imported activity only/);assert.match(html,/reversals/i);
 assert.doesNotMatch(html,/YTD|reimport/i);
});
test('income preserves a cent across large signed cancellation',()=>{
 const tx=[...Array.from({length:100},()=>income(-1e12)),income(-.01),...Array.from({length:100},()=>income(1e12))];
 assert.deepEqual(investmentIncome(account,tx),{total:1,cash:0,reinvested:0,unknown:1,count:201,excluded:0});
 assert.match(renderInvestmentIncome(account,tx),/\$0\.01/);
});
test('income guards each final total and bucket without discarding valid reversals',()=>{
 const cases=[
  {tx:[income(-1e12,'cash'),income(-.01,'cash')],expected:{total:null,cash:null,reinvested:0,unknown:0}},
  {tx:[income(1e12,'reinvested'),income(.01,'reinvested')],expected:{total:null,cash:0,reinvested:null,unknown:0}},
  {tx:[income(-1e12),income(-.01),income(1e12,'cash')],expected:{total:1,cash:-1e14,reinvested:0,unknown:null}},
  {tx:[income(-1e12,'cash'),income(-.01,'cash'),income(1e12,'reinvested'),income(.01,'reinvested')],expected:{total:0,cash:null,reinvested:null,unknown:0}},
  {tx:[income(-1e12,'cash'),income(-1e12,'reinvested')],expected:{total:null,cash:1e14,reinvested:1e14,unknown:0}},
 ];
 for(const {tx,expected} of cases){
  assert.deepEqual(investmentIncome(account,tx),{...expected,count:tx.length,excluded:0});
  const html=renderInvestmentIncome(account,tx);
  for(const [key,label] of Object.entries({total:'Net recorded distributions',cash:'Paid to cash',reinvested:'Reinvested',unknown:'Unknown treatment'})){
   if(expected[key]===null) assert.ok(html.includes(`<span>${label}</span><strong>Unavailable</strong>`),`${label} must not display an unavailable value as zero`);
  }
  assert.match(html,/exceed[^<]*supported range[^<]*1,000,000,000,000/i);
  assert.doesNotMatch(html,/Infinity|NaN|\bnull\b/);
 }
});
test('income excludes amounts that cannot safely convert to supported cents',()=>{
 const invalid=[NaN,Infinity,-Infinity,1e12+.01,-1e12-.01,Number.MAX_SAFE_INTEGER,'1'];
 const tx=[...invalid.map(n=>income(n)),income(-.01),income(-999,'cash',{pending:true}),income(-999,'cash',{iso_currency_code:'EUR'})];
 assert.deepEqual(investmentIncome(account,tx),{total:1,cash:0,reinvested:0,unknown:1,count:1,excluded:invalid.length+2});
 assert.match(renderInvestmentIncome(account,tx),/unavailable or unsupported amounts/i);
});
test('activity never infers legacy investment classification',()=>{
 const html=renderInvestmentActivity(account,[{name:'DIVIDEND RECEIVED',amount:-100,date:'2026-11-10'},income(-1)]);
 assert.match(html,/Unclassified cash activity/);assert.match(html,/Income/);
 assert.doesNotMatch(renderInvestmentActivity(account,[{name:'<img src=x>',amount:1}], 'trade'),/img src/);
});
test('investment views alone branch below preserved generic controls',()=>{
 const html=renderAccountDetail(account,[]);
 assert.match(html,/id="investment-detail"/);assert.match(html,/id="account-balance-options"/);assert.match(html,/id="import-transactions"/);assert.match(html,/id="account-import-dialog"/);
 assert.doesNotMatch(renderAccountDetail({...account,type:'depository'},[]),/id="investment-detail"/);
 const saved=renderInvestmentDetail({...account,source:'saved',canImport:false},[],[]);
 assert.doesNotMatch(saved,/id="investment-add-snapshot"|id="investment-snapshot-form"/);
 for(const tab of ['summary','holdings','activity','income']) assert.match(html,new RegExp(`id="investment-tab-${tab}"[^>]*role="tab"`));
});
test('search handles empty results and escaped source data without manufacturing values',()=>{
 assert.match(renderInvestmentHoldings(account,snapshot,'missing'),/No holdings match/);
 assert.match(renderInvestmentHoldings(account,snapshot,'example'),/View AAA holding/);
 assert.doesNotMatch(renderInvestmentHoldings(account,snapshot,'example'),/View CORE holding/);
 assert.match(renderInvestmentActivity(account,[], 'all', 'missing'),/No activity matches/);
 assert.match(renderInvestmentActivity(account,[{name:'<script>alert(1)</script>',amount:2}]),/&lt;script&gt;/);
 assert.doesNotMatch(renderInvestmentActivity(account,[{name:'x',amount:2}]),/\$2.00/);
 assert.equal(investmentIncome({...account,currencyCode:null},[income(-50)]).total,0);
 assert.equal(investmentIncome(account,[income(1.01),income(-.02)]).total,-99);
});

test('manual snapshot workflow is explicit preview then confirmation, exact template and local download',()=>{
 const html=renderInvestmentDetail(account,[],[]);
 assert.match(html,/id="investment-snapshot-form" method="post"/);
 assert.match(html,/symbol,name,quantity,price,marketValue,costBasis,isCash/);
 assert.match(html,/id="investment-confirm"[^>]*disabled/);
 assert.match(html,/transaction.history CSV/i);
 const source=readFileSync(new URL('../src/investments.ts',import.meta.url),'utf8');
 assert.match(source,/\.isConnected/);assert.match(source,/signal/);assert.match(source,/createObjectURL/);assert.match(source,/Unable to confirm/i);
 const css=readFileSync(new URL('../src/investments.css',import.meta.url),'utf8');
 assert.match(css,/@media\s*\(max-width:\s*800px\)/);assert.match(css,/min-height:\s*44px/);assert.match(css,/font-size:\s*16px/);
});
