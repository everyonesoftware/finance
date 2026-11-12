import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'vite';
import { chromium } from 'playwright';

// Browser-only fixtures exercising the real entry point. No database or financial writes.
const accounts = [
  { id:'checking',providerAccountId:'checking',itemId:'bank',name:'Everyday checking',institutionName:'Example Bank',type:'depository',subtype:'checking',mask:'4821',currentBalance:8450 },
  { id:'savings',providerAccountId:'savings',itemId:'bank',name:'High-yield savings',institutionName:'Example Bank',type:'depository',subtype:'savings',mask:'0932',currentBalance:26750 },
  { id:'investments',providerAccountId:'investments',itemId:'investments',name:'Investment account',institutionName:'Example Investments',type:'investment',subtype:'brokerage',mask:'7710',currentBalance:92400 },
  { id:'card',providerAccountId:'card',itemId:'card',name:'Credit card',institutionName:'CapitalOne',type:'credit',subtype:'credit card',mask:'1048',currentBalance:2180 },
].map(a=>({...a,currencyCode:'USD',availableBalance:null,officialName:null,source:'manual',canImport:true,updatedAt:new Date().toISOString()}));
const today = new Date().toISOString().slice(0,10);
const points = Array.from({length:365},(_,i)=>({date:new Date(Date.parse(today)-(364-i)*86400000).toISOString().slice(0,10),total:101200+Math.round(24220*i/364)}));
const summary={currencyCode:'USD',total:125420,accountCount:4,includedAccountCount:4,excludedAccountCount:0,unknownBalanceCount:0,points};
const transactions=[
  {transaction_id:'payroll',account_id:'checking',name:'Payroll deposit',amount:-3200,date:today,iso_currency_code:'USD'},
  ...[1,2].map(i=>({transaction_id:'reward-'+i,account_id:'card',name:'CREDIT-TRAVEL REWARD CREDIT-TRAVEL REWARD',amount:-5,date:today,iso_currency_code:'USD'})),
  {transaction_id:'grocery',account_id:'card',name:'Whole Foods Market',amount:86.42,date:today,iso_currency_code:'USD'},
];
const user={id:'preview',name:'Preview User',username:'preview',email:'preview@example.test',emailVerified:true,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};

test('approved Overview layout, genuine-history states and static chart through the real app', async t=>{
  const cacheDir=await mkdtemp(join(process.env.TMPDIR ?? tmpdir(),'finance-overview-vite-'));
  const server=await createServer({configFile:false,cacheDir,server:{host:'127.0.0.1',port:0,hmr:false}});
  await server.listen();t.after(async()=>{await server.close();await rm(cacheDir,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
  const browser=await chromium.launch({headless:true,...(process.platform==='win32'?{channel:'msedge'}:{})});
  t.after(()=>browser.close());
  const page=await browser.newPage();
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  let mode='ready';let totalRequests=0;
  await page.route('**/api/**', async route=>{
    const path=new URL(route.request().url()).pathname;
    assert.equal(route.request().method(),'GET','Overview must not initiate account mutations');
    if(path==='/api/auth/get-session')return route.fulfill({json:{user,session:{id:'session',userId:'preview',token:'fixture',expiresAt:'2099-01-01T00:00:00Z'}}});
    if(path==='/api/accounts/net-worth'){
      totalRequests++;
      if(mode==='error')return route.fulfill({status:503,json:{error:'Unavailable'}});
      const data=mode==='empty'?{...summary,total:null,accountCount:0,includedAccountCount:0,points:[]}:mode==='one'?{...summary,points:points.slice(-1)}:summary;
      return route.fulfill({json:data});
    }
    if(path==='/api/accounts')return route.fulfill({json:{accounts,configured:false}});
    if(path==='/api/accounts/transactions/all')return route.fulfill({json:{accounts,transactions,configured:false}});
    return route.fulfill({status:404,json:{error:'Fixture API not found'}});
  });
  const origin=`http://127.0.0.1:${server.httpServer.address().port}`;
  await page.goto(origin+'/dashboard');
  await page.locator('#overview-total-balance').filter({hasText:'$125,420.00'}).waitFor();
  await page.locator('#transaction-list details').waitFor();
  for(const width of [1440,1024,801,800,390,320]){
    await page.setViewportSize({width,height:900});
    await page.evaluate(()=>window.scrollTo(0,0));
    const state=await page.evaluate(()=>{
      const bounds=selector=>document.querySelector(selector).getBoundingClientRect().toJSON();
      const size=selector=>parseFloat(getComputedStyle(document.querySelector(selector)).fontSize);
      const date=document.querySelector('.overview-date');
      const text=date.querySelector(matchMedia('(max-width:800px)').matches?'.overview-date-short':'.overview-date-long');
      const range=document.createRange();range.selectNodeContents(text);
      const r=date.getBoundingClientRect(),s=text.getBoundingClientRect();
      return {copy:bounds('.overview-balance-copy'),chart:bounds('.overview-history'),transactions:bounds('#transactions'),accounts:bounds('#accounts'),overflow:document.documentElement.scrollWidth>document.documentElement.clientWidth,description:size('#transaction-list .transaction-copy strong'),amount:size('#transaction-list .transaction-row > b'),metadata:size('#transaction-list .transaction-copy span'),dateLines:range.getClientRects().length,dateOffset:Math.abs((r.top+r.bottom-s.top-s.bottom)/2),chartCount:document.querySelector('.overview-chart').dataset.observationCount};
    });
    assert.equal(state.overflow,false,`overflow at ${width}`);
    assert.equal(state.dateLines,1,`date wraps at ${width}`);assert.ok(state.dateOffset<=1,`date off center at ${width}`);
    assert.equal(state.chartCount,'365');
    if(width>800)assert.ok(state.chart.left>=state.copy.right,`chart must be right of number at ${width}`);
    else{
      assert.ok(state.chart.top>=state.copy.bottom);
      assert.ok(state.transactions.top<state.accounts.top);
      assert.ok(state.description>=16);assert.ok(state.amount>=16);assert.ok(state.metadata>=14);
    }
    const before=await page.locator('.overview-chart').innerHTML();
    await page.locator('.overview-chart').hover();await page.locator('.overview-chart').click();
    assert.equal(await page.locator('.overview-chart').innerHTML(),before,'chart remains static');
    assert.equal(await page.locator('#overview input[type=range],#overview .crosshair').count(),0);
    await page.locator('#transaction-list details summary').click();
    const rightEdges=await page.evaluate(()=>[...document.querySelectorAll('#transaction-list .transaction-row > b,#transaction-list .transfer-pair-amount')].filter(el=>el.getBoundingClientRect().height).map(el=>el.getBoundingClientRect().right));
    assert.ok(Math.max(...rightEdges)-Math.min(...rightEdges)<1,`amount alignment at ${width}`);
    await page.locator('#transaction-list details summary').click();
    await page.evaluate(()=>window.scrollTo(0,0));
    if(process.env.FINANCE_OVERVIEW_SCREENSHOTS&&[1440,390].includes(width)){
      await mkdir(process.env.FINANCE_OVERVIEW_SCREENSHOTS,{recursive:true});
      await page.screenshot({path:join(process.env.FINANCE_OVERVIEW_SCREENSHOTS,`overview-${width}.png`),fullPage:width>800});
    }
  }
  for(const [state,text] of [['one','Not enough history yet'],['empty','Your history starts here'],['error','History unavailable']]){
    mode=state;await page.reload();await page.getByRole('heading',{name:text}).waitFor();
    assert.equal(await page.locator('.overview-chart').count(),0);
  }
  mode='ready';const requestsBefore=totalRequests;
  await page.getByRole('button',{name:'Try again',exact:true}).click();
  await page.locator('.overview-chart').waitFor();
  assert.equal(totalRequests,requestsBefore+1);
  assert.deepEqual(errors,[]);
});
