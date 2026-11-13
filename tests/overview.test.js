import assert from 'node:assert/strict';
import test from 'node:test';
import * as dashboard from '../src/dashboard.ts';
import { renderOverviewBankAccounts } from '../src/bank_accounts.ts';

const user = { displayName: 'Overview Tester', username: 'overview' };

test('Overview account balances show credit and loan amounts as liabilities', () => {
  const account = {id:'card',name:'Card',institutionName:'Bank',type:'credit',subtype:'credit card',currentBalance:2180,currencyCode:'USD'};
  assert.match(renderOverviewBankAccounts([account]), /-\$2,180\.00/);
  assert.match(renderOverviewBankAccounts([{...account,type:'loan',currentBalance:-2180}]), /-\$2,180\.00/);
});

test('Overview renders the approved quiet ledger with net worth, date and transactions first', () => {
  const html = dashboard.renderDashboard(user, new Date('2026-11-12T12:00:00Z'));
  assert.match(html, /id="overview-net-worth"/);
  assert.match(html, />Net worth</);
  assert.match(html, /id="overview-net-worth-chart"/);
  assert.match(html, /datetime="2026-11-12"/);
  assert.match(html, /12 Nov 2026/);
  assert.match(html, /12 November 2026/);
  assert.ok(html.indexOf('id="transactions"') < html.indexOf('id="accounts"'));
  assert.doesNotMatch(html, /type="range"|Hide balances|Sample data|Illustrative history|balance-decoration/);
  assert.match(html, /href="\/transactions"/);
  assert.match(html, /href="\/accounts"/);
});

test('static net-worth history uses observation dates in the 365-day window, never backfills missing days', () => {
  assert.equal(typeof dashboard.renderNetWorthHistory, 'function');
  const html = dashboard.renderNetWorthHistory([
    { date: '2026-11-12', total: 200 },
    { date: '2025-11-13', total: 100 },
    { date: '2025-11-12', total: 99999 },
    { date: '2026-11-13', total: 99999 },
    { date: '2026-02-30', total: 99999 },
  ], new Date('2026-11-12T12:00:00Z'));
  assert.match(html, /<polyline/);
  assert.match(html, /data-observation-count="2"/);
  assert.match(html, /points="0,[\d.]+ 700,[\d.]+"/);
  assert.match(html, /role="img"/);
  assert.doesNotMatch(html, /onpointer|tabindex|crosshair|type="range"|class="chart-value"/);
  assert.match(html, /gaps connect saved observations/i);
});

test('insufficient history does not fabricate a flat line or performance gain', () => {
  assert.equal(typeof dashboard.renderNetWorthHistory, 'function');
  for (const points of [[], [{ date: '2026-11-12', total: 125420 }]]) {
    const html = dashboard.renderNetWorthHistory(points, new Date('2026-11-12T12:00:00Z'));
    assert.doesNotMatch(html, /<svg|<polyline/);
    assert.match(html, /Not enough history yet/);
  }
});

test('trend change handles losses, zero starting balances and negative net worth', () => {
  assert.equal(typeof dashboard.formatNetWorthChange, 'function');
  const points = (a,b) => [{date:'2025-11-13',total:a},{date:'2026-11-12',total:b}];
  assert.equal(dashboard.formatNetWorthChange(points(100,125)), '+$25.00 (+25.0%) since first history point');
  assert.equal(dashboard.formatNetWorthChange(points(100,50)), '−$50.00 (−50.0%) since first history point');
  assert.equal(dashboard.formatNetWorthChange(points(0,50)), '+$50.00 since first history point');
  assert.equal(dashboard.formatNetWorthChange(points(-100,-50)), '+$50.00 since first history point');
  assert.equal(dashboard.formatNetWorthChange(points(100,100)), '$0.00 (0.0%) since first history point');
  assert.equal(dashboard.formatNetWorthChange([]), '');
});

function overviewDOM(t) {
  const nodes = Object.fromEntries(['#overview-total-balance', '#overview-net-worth-chart', '#overview-net-worth-coverage', '#overview-net-worth-change'].map(id => [id, { innerHTML: '', textContent: '', addEventListener() {}, querySelector() { return null; } }]));
  const root = { isConnected: true, querySelector: selector => nodes[selector] ?? null };
  const before = globalThis.document;
  globalThis.document = { querySelector: selector => selector === '#overview-net-worth' ? root : null };
  t.after(() => { globalThis.document = before; });
  return { nodes, root };
}
const summary = { currencyCode: 'USD', total: 200, accountCount: 2, includedAccountCount: 1, excludedAccountCount: 1, unknownBalanceCount: 0, points: [{date:'2026-11-12',total:200}] };

test('mixed history explicitly distinguishes reconstructed estimates from saved observations', () => {
  const html = dashboard.renderNetWorthHistory([
    {date:'2026-11-11',total:100,source:'reconstructed'},
    {date:'2026-11-12',total:200,source:'observed'},
  ], new Date('2026-11-12T12:00:00Z'));
  assert.match(html, /Observed and reconstructed history/);
  assert.match(html, /data-observation-count="1"/);
  assert.match(html, /data-reconstructed-count="1"/);
  assert.match(html, /aria-label="[^"]*1 saved observation[^"]*1 reconstructed estimated day/);
  assert.match(html, /Reconstructed points assume complete posted imports and are not verified/);
  assert.match(html, /aria-label="[^"]*gaps connect history points/);
  assert.match(html, /class="overview-history-note">Reconstructed points assume complete posted imports and are not verified\.<\/p>/,'keep mobile disclosure compact; detailed counts belong in the accessible description');
  assert.doesNotMatch(html, /onpointer|tabindex|crosshair|type="range"/);
});

test('observed-only history remains clearly observed without a reconstruction claim', () => {
  const html = dashboard.renderNetWorthHistory([
    {date:'2026-11-11',total:100}, {date:'2026-11-12',total:200,source:'observed'},
  ], new Date('2026-11-12T12:00:00Z'));
  assert.match(html, /Saved balance history/);
  assert.match(html, /2 saved observations/);
  assert.doesNotMatch(html, /assume complete posted imports|reconstructed estimated day/);
});

test('insufficient history explains dated balances and posted imports or observations on two days', () => {
  for (const points of [[], [{date:'2026-11-12',total:100,source:'reconstructed'}]]) {
    const html = dashboard.renderNetWorthHistory(points, new Date('2026-11-12T12:00:00Z'));
    assert.match(html, /dated.*balance.*posted imports/i);
    assert.match(html, /two different days/);
    assert.doesNotMatch(html, /past balances are not reconstructed|<svg/);
    if (points.length) assert.match(html, /Reconstructed points assume complete posted imports and are not verified/);
  }
});

test('Overview explains unsupported reconstruction coverage without inventing investment valuations', async t => {
  const { nodes } = overviewDOM(t);
  t.mock.method(globalThis, 'fetch', async () => ({ok:true,json:async()=>({...summary,history:{reconstructedPointCount:0,eligibleAccountCount:0,unsupportedAccountCount:1}})}));
  await dashboard.initializeOverviewNetWorth();
  const text = nodes['#overview-net-worth-coverage'].textContent;
  assert.match(text, /1.*account.*cannot.*reconstruct/i);
  assert.match(text, /dated verified balance.*historical investment valuations/i);
  assert.match(text, /all included USD accounts/i);
});

for (const invalid of [
  {points:[{date:'2026-11-12',total:200,source:'estimated'}]},
  {points:[{date:'2026-11-12',total:200,source:null}]},
  {history:null},
  ...['reconstructedPointCount','eligibleAccountCount','unsupportedAccountCount'].flatMap(key =>
    [-1,1.5,'1'].map(value => ({history:{reconstructedPointCount:0,eligibleAccountCount:1,unsupportedAccountCount:0,[key]:value}}))),
]) test(`Overview rejects invalid optional history metadata/source ${JSON.stringify(invalid)}`, async t => {
  const { nodes } = overviewDOM(t);
  t.mock.method(globalThis, 'fetch', async () => ({ok:true,json:async()=>({...summary,...invalid})}));
  await dashboard.initializeOverviewNetWorth();
  assert.equal(nodes['#overview-total-balance'].textContent, 'Unavailable');
  assert.match(nodes['#overview-net-worth-chart'].innerHTML, /History unavailable/);
});

test('Overview accepts reconstructed API points and optional history metadata', async t => {
  const { nodes } = overviewDOM(t);
  const today = new Date().toISOString().slice(0,10);
  const yesterday = new Date(Date.parse(today)-86400000).toISOString().slice(0,10);
  t.mock.method(globalThis, 'fetch', async () => ({ok:true,json:async()=>({...summary,points:[{date:yesterday,total:100,source:'reconstructed'},{date:today,total:200}],history:{reconstructedPointCount:1,eligibleAccountCount:1,unsupportedAccountCount:0}})}));
  await dashboard.initializeOverviewNetWorth();
  assert.match(nodes['#overview-net-worth-chart'].innerHTML, /Reconstructed points assume complete posted imports and are not verified/);
  assert.equal(nodes['#overview-net-worth-change'].textContent, '+$100.00 (+100.0%) since first history point');
});

test('Overview initializes actual scoped totals with coverage and insufficient-history messaging', async t => {
  assert.equal(typeof dashboard.initializeOverviewNetWorth, 'function');
  const { nodes } = overviewDOM(t);
  const controller = new AbortController();
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, '/api/accounts/net-worth');
    assert.equal(options.cache, 'no-store');
    assert.equal(options.signal, controller.signal);
    return { ok: true, json: async () => summary };
  });
  await dashboard.initializeOverviewNetWorth(controller.signal);
  assert.equal(nodes['#overview-total-balance'].textContent, '$200.00');
  assert.match(nodes['#overview-net-worth-coverage'].textContent, /1.*non-USD|1.*other currenc/i);
  assert.match(nodes['#overview-net-worth-chart'].innerHTML, /Not enough history yet/);
  assert.equal(nodes['#overview-net-worth-change'].textContent, '');
});

test('Overview error and retry states do not masquerade as a zero net worth', async t => {
  assert.equal(typeof dashboard.initializeOverviewNetWorth, 'function');
  const { nodes } = overviewDOM(t);
  t.mock.method(globalThis, 'fetch', async () => { throw Error('offline'); });
  await dashboard.initializeOverviewNetWorth();
  assert.equal(nodes['#overview-total-balance'].textContent, 'Unavailable');
  assert.match(nodes['#overview-net-worth-chart'].innerHTML, /Try again/);
  globalThis.fetch = async () => ({ok:true,json:async()=>({...summary,total:null,unknownBalanceCount:1})});
  await dashboard.initializeOverviewNetWorth();
  assert.equal(nodes['#overview-total-balance'].textContent, 'Balance unavailable');
  assert.match(nodes['#overview-net-worth-coverage'].textContent, /1.*missing|1.*unavailable/i);
});

for (const mode of ['abort', 'detach', 'both']) test(`Overview ignores a late summary after ${mode}`, async t => {
  assert.equal(typeof dashboard.initializeOverviewNetWorth, 'function');
  const { nodes, root } = overviewDOM(t);
  let resolve;
  t.mock.method(globalThis, 'fetch', () => new Promise(done => {resolve=done;}));
  const controller = new AbortController();
  const pending = dashboard.initializeOverviewNetWorth(controller.signal);
  if (mode !== 'detach') controller.abort();
  if (mode !== 'abort') root.isConnected=false;
  resolve({ok:true,json:async()=>summary});
  await pending;
  assert.equal(nodes['#overview-total-balance'].textContent, '');
  assert.equal(nodes['#overview-net-worth-chart'].innerHTML, '');
});
