import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { createBankAccountsRouter } from '../server/bank_accounts.ts';
import { applySqlMigration } from '../server/migration-utils.ts';
import { fidelityHistory } from './fixtures/fidelity-history.js';

// All financial records are synthetic. Requests use the production account
// router against fully migrated, isolated SQLite, never the user's database.
const key = Buffer.alloc(32, 57);
const csv = 'symbol,name,quantity,price,marketValue,costBasis,isCash\nDEMO,Example Fund,10,100,1000,800,false\nMISSING,Unknown Basis,5,20,100,,false\n';
const accountInput = { name: 'Synthetic brokerage', institutionName: 'Example Fidelity', type: 'investment', subtype: 'brokerage', currencyCode: 'USD', currentBalance: 1200, balanceDate: '2026-10-30' };
const snapshotInput = { valuationDate: '2026-10-30', source: 'Synthetic source statement', accountValue: 1200, cashBalance: 100, holdings: [
  { symbol: 'DEMO', name: 'Example Fund', quantity: 10, price: 100, marketValue: 1000, costBasis: 800, isCash: false },
  { symbol: 'MISSING', name: 'Unknown Basis', quantity: 5, price: 20, marketValue: 100, costBasis: null, isCash: false },
] };

async function fixture(t, browser, origin, options = {}) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys=ON');
  t.after(() => db.close());
  const dir = new URL('../server/migrations/', import.meta.url);
  for (const name of (await readdir(dir)).filter(name => name.endsWith('.sql')).sort()) applySqlMigration(db, await readFile(new URL(name, dir), 'utf8'));
  db.prepare('INSERT INTO user(id,name,email) VALUES(?,?,?)').run('investment-owner', 'Synthetic User', 'investments@example.test');
  const router = createBankAccountsRouter({ database: db, getUserId: async () => 'investment-owner', getEncryptionKey: () => key, trustedOrigins: [origin], now: () => new Date('2026-11-13T12:00:00Z') });
  const request = async (path, body, method = 'POST') => router.request(new Request(origin + path, { method, headers: { 'content-type': 'application/json', origin }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
  const created = await request('/', accountInput);
  assert.equal(created.status, 201);
  const account = (await created.json()).account;
  const context = await browser.newContext({ locale: 'en-US', viewport: { width: options.width ?? 1120, height: 875 }, hasTouch: options.hasTouch ?? false });
  t.after(() => context.close());
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors = [], calls = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', async route => {
    const incoming = route.request(), url = new URL(incoming.url());
    if (url.pathname === '/api/auth/get-session') return route.fulfill({ json: { user: { id: 'investment-owner', name: 'Synthetic User', username: 'synthetic', email: 'investments@example.test', emailVerified: true, createdAt: '2020-01-01T00:00:00Z', updatedAt: '2020-01-01T00:00:00Z' }, session: { id: 'investment-session', userId: 'investment-owner', token: 'fixture', expiresAt: '2099-01-01T00:00:00Z' } } });
    assert.ok(url.pathname.startsWith('/api/accounts'), `unexpected API ${url.pathname}`);
    const path = url.pathname.slice('/api/accounts'.length) || '/';
    const method = incoming.method();
    const response = await router.request(new Request(origin + path + url.search, { method, headers: await incoming.allHeaders(), ...(['GET', 'HEAD'].includes(method) ? {} : { body: incoming.postDataBuffer() }) }));
    const body = await response.text();
    calls.push({ path, method, status: response.status, response: JSON.parse(body) });
    return route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body });
  });
  const seedSnapshot = async (changes = {}) => {
    const response = await request(`/${account.id}/investments`, { snapshot: { ...snapshotInput, ...changes } });
    assert.equal(response.status, 201, await response.clone().text());
    return (await response.json()).snapshot;
  };
  const importActivity = async () => {
    const body = { fileName: 'history.csv', content: fidelityHistory };
    const preview = await request(`/${account.id}/import/preview`, body);
    assert.equal(preview.status, 200, await preview.clone().text());
    const result = await preview.json();
    const saved = await request(`/${account.id}/import`, { ...body, previewToken: result.previewToken });
    assert.equal(saved.status, 200, await saved.clone().text());
  };
  const open = async () => { await page.goto(origin + '/accounts/' + account.id); await page.getByRole('tab', { name: 'Summary', exact: true }).waitFor(); };
  return { db, page, request, account, seedSnapshot, importActivity, open, calls, errors };
}

async function settledDialogFocus(page, dialog, trigger) {
  await page.waitForFunction(async ({ dialog, trigger }) => {
    // Native focus restoration can precede the queued close listener.
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return !document.querySelector(dialog).open && document.activeElement === document.querySelector(trigger);
  }, { dialog, trigger });
}

async function noOverflow(page, width) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false, `no horizontal page overflow ${width}`);
}
async function screenshot(page, name, width) {
  if (!process.env.FINANCE_INVESTMENTS_SCREENSHOTS || ![1120, 390].includes(width)) return;
  await mkdir(process.env.FINANCE_INVESTMENTS_SCREENSHOTS, { recursive: true });
  await page.screenshot({ path: join(process.env.FINANCE_INVESTMENTS_SCREENSHOTS, `investments-${name}-${width}.png`), fullPage: true });
}

test('investment views through real frontend, router and encrypted SQLite', { timeout: 180000 }, async t => {
  const cacheDir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), 'finance-investments-vite-'));
  const server = await createServer({ configFile: false, cacheDir, server: { host: '127.0.0.1', port: 0, hmr: false } });
  await server.listen();
  t.after(async () => { await server.close(); await rm(cacheDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) });
  t.after(() => browser.close());
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;

  for (const width of [1120, 390, 320]) await t.test(`brokerage empty state, snapshots and view navigation at ${width}`, async t => {
    const f = await fixture(t, browser, origin, { width }), { page } = f;
    await f.open();
    await page.getByRole('button', { name: 'Add snapshot', exact: true }).first().waitFor();
    await noOverflow(page, width);
    if (width === 390) {
      const tab = await page.getByRole('tab', { name: 'Summary', exact: true }).boundingBox();
      assert.ok(tab.y + tab.height < 790, 'investment tabs are visible above phone navigation without scrolling');
    }
    await screenshot(page, 'empty', width);
    await page.getByRole('button', { name: 'Add snapshot', exact: true }).click();
    await page.getByLabel('Valuation date', { exact: true }).fill('2026-10-30');
    await page.getByLabel('Source', { exact: true }).fill('Synthetic source statement');
    await page.getByLabel('Account value', { exact: true }).fill('1200');
    await page.getByLabel('Separate cash', { exact: true }).fill('100');
    await page.getByLabel('Holdings CSV', { exact: true }).setInputFiles({ name: 'holdings.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
    await page.getByRole('button', { name: 'Preview snapshot', exact: true }).click();
    await page.getByRole('heading', { name: 'Review before saving', exact: true }).waitFor();
    assert.equal(f.db.prepare('SELECT count(*) n FROM investment_snapshot').get().n, 0, 'preview does not save');
    await noOverflow(page, width);
    await screenshot(page, 'preview', width);
    await page.getByRole('button', { name: 'Confirm save', exact: true }).click();
    await page.locator('#investment-snapshot-dialog[open]').waitFor({ state: 'hidden' });
    assert.equal(f.db.prepare('SELECT count(*) n FROM investment_snapshot').get().n, 1, 'confirmed UI save persists');
    await f.importActivity();
    await f.open();
    await page.getByText('Synthetic source statement', { exact: false }).first().waitFor();
    await screenshot(page, 'summary', width);
    await page.getByRole('tab', { name: 'Holdings', exact: true }).click();
    await page.getByLabel('Search holdings', { exact: true }).fill('not a holding');
    await page.getByText(/no holdings match/i).waitFor();
    await page.getByLabel('Search holdings', { exact: true }).fill('');
    await page.getByText('Example Fund', { exact: true }).first().waitFor();
    await page.getByRole('button', { name: 'View MISSING holding', exact: true }).click();
    await page.getByText('Unavailable without cost basis', { exact: true }).waitFor();
    await page.keyboard.press('Escape');
    await settledDialogFocus(page, '#investment-details-dialog', '[aria-label="View MISSING holding"]');
    assert.equal(await page.getByRole('button', { name: 'View MISSING holding', exact: true }).evaluate(el => el === document.activeElement), true);
    await page.getByRole('button', { name: 'View DEMO holding', exact: true }).click();
    await page.getByText('$200.00', { exact: true }).waitFor();
    await page.locator('#investment-details-close').click();
    await settledDialogFocus(page, '#investment-details-dialog', '[aria-label="View DEMO holding"]');
    await noOverflow(page, width);
    await screenshot(page, 'holdings', width);
    for (const name of ['Activity', 'Income', 'Summary']) {
      await page.getByRole('tab', { name, exact: true }).click();
      assert.equal(await page.getByRole('tab', { name, exact: true }).getAttribute('aria-selected'), 'true');
      if (name === 'Activity') {
        await page.getByLabel('Activity type', { exact: true }).selectOption('income');
        assert.equal(await page.locator('#investment-panel-activity .investment-activity-row').count(), 2);
        await page.getByLabel('Activity type', { exact: true }).selectOption('all');
      }
      if (name === 'Income') await page.getByText('$25.01', { exact: true }).first().waitFor();
      await noOverflow(page, width);
      await screenshot(page, name.toLowerCase(), width);
    }
    await page.getByRole('button', { name: 'Snapshot details', exact: true }).click();
    await page.locator('#investment-details-dialog[open]').waitFor();
    await page.keyboard.press('Escape');
    await settledDialogFocus(page, '#investment-details-dialog', '#investment-snapshot-details');
    assert.equal(await page.getByRole('button', { name: 'Snapshot details', exact: true }).evaluate(el => el === document.activeElement), true);
    assert.deepEqual(f.errors, []);
  });

  await t.test('phone touch, keyboard tabs and snapshot cancellation restore focus', async t => {
    const f = await fixture(t, browser, origin, { width: 390, hasTouch: true }), { page } = f;
    await f.seedSnapshot();
    await f.open();
    await page.getByRole('button', { name: 'Snapshot details', exact: true }).waitFor();
    for (const selector of ['#investment-tab-summary', '#investment-tab-holdings', '#investment-add-snapshot']) {
      const box = await page.locator(selector).boundingBox();
      assert.ok(box.width >= 44 && box.height >= 44, `${selector} has a 44px touch target`);
    }
    await page.getByRole('tab', { name: 'Holdings', exact: true }).tap();
    await page.getByRole('button', { name: 'View DEMO holding', exact: true }).tap();
    await page.locator('#investment-details-dialog[open]').waitFor();
    await page.locator('#investment-details-close').tap();
    await settledDialogFocus(page, '#investment-details-dialog', '[aria-label="View DEMO holding"]');
    assert.equal(await page.getByRole('button', { name: 'View DEMO holding', exact: true }).evaluate(el => el === document.activeElement), true);
    await page.getByRole('button', { name: 'Add snapshot', exact: true }).tap();
    await page.locator('#investment-snapshot-cancel').tap();
    await settledDialogFocus(page, '#investment-snapshot-dialog', '#investment-add-snapshot');
    assert.equal(await page.locator('#investment-add-snapshot').evaluate(el => el === document.activeElement), true);
    await page.getByRole('tab', { name: 'Holdings', exact: true }).focus();
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.getByRole('tab', { name: 'Activity', exact: true }).getAttribute('aria-selected'), 'true');
    await page.keyboard.press('Home');
    assert.equal(await page.getByRole('tab', { name: 'Summary', exact: true }).getAttribute('aria-selected'), 'true');
    assert.deepEqual(f.errors, []);
  });

  await t.test('snapshot read failure offers retry without hiding imported activity', async t => {
    const f = await fixture(t, browser, origin), { page } = f;
    await f.importActivity();
    let fail = true;
    await page.route('**/api/accounts/*/investments', async route => {
      if (fail) return route.fulfill({ status: 503, json: { error: 'Unavailable' } });
      return route.fallback();
    });
    await f.open();
    await page.getByRole('button', { name: 'Retry snapshots', exact: true }).waitFor();
    await page.getByRole('tab', { name: 'Income', exact: true }).click();
    await page.getByText('$25.01', { exact: true }).first().waitFor();
    fail = false;
    await page.getByRole('button', { name: 'Retry snapshots', exact: true }).click();
    await page.getByText('No saved holdings snapshots.', { exact: true }).waitFor();
    assert.deepEqual(f.errors, []);
  });

  for (const stage of ['load', 'preview', 'save', 'readback']) for (const mode of ['abort', 'detach']) {
    await t.test(`late ${stage} response cannot mutate another account after ${mode}`, async t => {
      const f = await fixture(t, browser, origin), { page } = f;
      await f.open();
      const result = await page.evaluate(async ({ account, snapshot, stage, mode, csv }) => {
        const module = await import('/src/investments.ts');
        const oldFetch = window.fetch;
        let release, requested;
        const gate = new Promise(resolve => { release = resolve; });
        const started = new Promise(resolve => { requested = resolve; });
        const host = document.createElement('div');
        document.body.append(host);
        host.innerHTML = module.renderInvestmentDetail(account, [], []);
        // The normal account page also has this id; isolate the exported initializer.
        document.querySelector('#account-detail-content')?.remove();
        const root = host.querySelector('#investment-detail');
        const controller = new AbortController();
        let posts = 0, gets = 0;
        window.fetch = async (_url, options = {}) => {
          const method = options.method ?? 'GET';
          if (method === 'POST' && String(_url).endsWith('/preview')) {
            if (stage === 'preview') { requested(); await gate; }
            return new Response(JSON.stringify({ snapshot }), { headers: { 'content-type': 'application/json' } });
          }
          if (method === 'POST') {
            posts++;
            if (stage === 'save') { requested(); await gate; }
            return new Response(JSON.stringify({ snapshot: { ...snapshot, id: 'saved-id', createdAt: '2026-11-13T00:00:00Z' } }), { headers: { 'content-type': 'application/json' } });
          }
          gets++;
          if (stage === 'load' || (stage === 'readback' && gets > 1)) { requested(); await gate; }
          return new Response(JSON.stringify({ snapshots: gets > 1 ? [{ ...snapshot, id: 'saved-id', createdAt: '2026-11-13T00:00:00Z' }] : [] }), { headers: { 'content-type': 'application/json' } });
        };
        let reloads = 0;
        const init = module.initializeInvestmentDetail(account, [], [], async () => { reloads++; }, controller.signal);
        if (stage !== 'load') {
          await init;
          root.querySelector('#investment-add-snapshot').click();
          const form = root.querySelector('form');
          for (const [key, value] of Object.entries({ valuationDate: snapshot.valuationDate, source: snapshot.source, accountValue: snapshot.accountValue, cashBalance: snapshot.cashBalance })) form.elements.namedItem(key).value = String(value);
          const transfer = new DataTransfer(); transfer.items.add(new File([csv], 'holdings.csv', { type: 'text/csv' }));
          form.elements.namedItem('csv').files = transfer.files;
          form.requestSubmit();
          if (stage === 'save' || stage === 'readback') {
            for (let i = 0; i < 100 && root.querySelector('#investment-confirm').disabled; i++) await new Promise(resolve => setTimeout(resolve, 5));
            root.querySelector('#investment-confirm').click();
          }
        }
        await started;
        root.querySelector('dialog[open]')?.close();
        if (mode === 'abort') controller.abort(); else root.remove();
        const before = root.innerHTML;
        const replacement = document.createElement('div'); replacement.id = 'investment-detail'; replacement.textContent = 'Account B must remain untouched'; host.append(replacement);
        const focus = document.createElement('button'); focus.textContent = 'Account B focus'; host.append(focus); focus.focus();
        release();
        await init;
        await new Promise(resolve => setTimeout(resolve, 30));
        window.fetch = oldFetch;
        return { unchanged: before === root.innerHTML, replacement: replacement.textContent, focused: document.activeElement === focus, reloads, posts };
      }, { account: f.account, snapshot: snapshotInput, stage, mode, csv });
      assert.equal(result.unchanged, true);
      assert.equal(result.replacement, 'Account B must remain untouched');
      assert.equal(result.focused, true);
      assert.equal(result.reloads, 0);
      assert.equal(result.posts, ['save', 'readback'].includes(stage) ? 1 : 0);
      assert.deepEqual(f.errors, []);
    });
  }
});
