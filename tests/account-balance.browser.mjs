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
import { decryptBankValue, encryptBankValue } from '../server/bank-crypto.ts';

// Synthetic data only. Every account request goes through the production Hono
// router and an isolated, migrated in-memory SQLite database, never a real API.
const key = Buffer.alloc(32, 17);
const referenceDate = '2020-01-15';
const accountInput = { name: 'Synthetic checking', institutionName: 'Example Test Bank', type: 'depository', subtype: 'checking', currencyCode: 'USD', mask: '1234', currentBalance: 1000, balanceDate: referenceDate };
const money = amount => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount);
const file = (name, rows) => ({ name, mimeType: 'text/csv', buffer: Buffer.from('Date,Description,Amount,ID\n' + rows.join('\n')) });
const statement = file('balance.csv', [
  '2020-01-14,Before reference,-20,before',
  '2020-01-15,On reference,-30,on',
  '2020-01-16,Later purchase,-25,later-out',
  '2020-01-17,Later deposit,100,later-in',
]);
const expectedBalance = 1000 - 25 + 100;

async function fixture(t, browser, origin) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys=ON');
  t.after(() => db.close());
  const dir = new URL('../server/migrations/', import.meta.url);
  for (const migration of (await readdir(dir)).filter(name => name.endsWith('.sql')).sort()) {
    applySqlMigration(db, await readFile(new URL(migration, dir), 'utf8'));
  }
  db.prepare('INSERT INTO user(id,name,email) VALUES(?,?,?)').run('balance-owner', 'Synthetic User', 'balance@example.test');
  const router = createBankAccountsRouter({ database: db, getUserId: async () => 'balance-owner', getEncryptionKey: () => key, trustedOrigins: [origin] });
  const request = (path, body, method = 'POST') => router.request(new Request(origin + path, {
    method, headers: { 'content-type': 'application/json', origin }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  const create = async (changes = {}) => {
    const response = await request('/', { ...accountInput, ...changes });
    assert.equal(response.status, 201, 'fixture account is accepted by real API');
    return (await response.json()).account;
  };
  const accounts = async () => (await (await request('/', undefined, 'GET')).json()).accounts;
  const saved = async id => (await accounts()).find(account => account.id === id);
  const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1120, height: 900 } });
  t.after(() => context.close());
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.setDefaultNavigationTimeout(30000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const calls = [];
  await page.route('**/api/**', async route => {
    const incoming = route.request();
    const url = new URL(incoming.url());
    if (url.pathname === '/api/auth/get-session') {
      return route.fulfill({ json: { user: { id: 'balance-owner', name: 'Synthetic User', username: 'synthetic', email: 'balance@example.test', emailVerified: true, createdAt: '2020-01-01T00:00:00Z', updatedAt: '2020-01-01T00:00:00Z' }, session: { id: 'balance-session', userId: 'balance-owner', token: 'fixture', expiresAt: '2099-01-01T00:00:00Z' } } });
    }
    assert.ok(url.pathname.startsWith('/api/accounts'), `unexpected API request ${url.pathname}`);
    const path = url.pathname.slice('/api/accounts'.length) || '/';
    const method = incoming.method();
    const headers = await incoming.allHeaders();
    // Keep the real origin so production same-origin checks run, not a bypass.
    const response = await router.request(new Request(origin + path + url.search, {
      method, headers, ...(['GET', 'HEAD'].includes(method) ? {} : { body: incoming.postDataBuffer() }),
    }));
    const body = await response.text();
    calls.push({ path, method, status: response.status, request: incoming.postDataJSON(), response: JSON.parse(body) });
    return route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body });
  });
  return { db, page, calls, request, create, accounts, saved, errors };
}

async function poll(check, message) {
  let value;
  for (let attempt = 0; attempt < 100; attempt++) {
    value = await check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(value, message);
}
async function detail(f, origin, account) {
  await f.page.goto(origin + '/accounts/' + account.id);
  await f.page.locator('#account-balance-options').waitFor();
}
async function openBalance(page) {
  await page.locator('#account-balance-options').click();
  await page.locator('#set-account-balance').click();
}
async function preview(f, upload = statement) {
  await f.page.locator('#import-transactions').click();
  await f.page.locator('#import-file').setInputFiles(upload);
  await f.page.locator('#import-date-format').selectOption('ymd');
  await f.page.locator('#import-next').click();
  await f.page.locator('#import-balance-impact .balance-impact').waitFor();
  return f.calls.filter(call => call.path.endsWith('/import/preview')).at(-1).response;
}
async function screenshot(page, name, width) {
  if (!process.env.FINANCE_BALANCE_SCREENSHOTS || ![1120, 390].includes(width)) return;
  await mkdir(process.env.FINANCE_BALANCE_SCREENSHOTS, { recursive: true });
  await page.screenshot({ path: join(process.env.FINANCE_BALANCE_SCREENSHOTS, `balance-${name}-${width}.png`) });
}
async function geometry(page, selector, width, fields = false) {
  const boxes = await page.locator(selector).evaluate((dialog, fields) => {
    const rect = el => el.getBoundingClientRect().toJSON();
    const body = dialog.querySelector('.account-workflow-body');
    body.scrollTop = body.scrollHeight;
    const footer = dialog.querySelector('footer');
    return {
      dialog: rect(dialog), body: rect(body), footer: rect(footer),
      height: innerHeight, width: innerWidth,
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      dialogOverflow: dialog.scrollWidth > dialog.clientWidth,
      bodyOverflow: body.scrollWidth > body.clientWidth,
      bodyScroll: getComputedStyle(body).overflowY,
      outerScroll: dialog.scrollHeight > dialog.clientHeight,
      buttons: [...footer.querySelectorAll('button')].map(rect),
      fields: fields ? [...dialog.querySelectorAll('.balance-reference-fields label')].map(rect) : [],
    };
  }, fields);
  assert.equal(boxes.overflow, false, `page overflow at ${width}`);
  assert.equal(boxes.dialogOverflow, false, `dialog overflow at ${width}`);
  assert.equal(boxes.bodyOverflow, false, `body overflow at ${width}`);
  assert.equal(boxes.outerScroll, false, `body, not entire dialog, owns scroll at ${width}`);
  assert.match(boxes.bodyScroll, /auto|scroll/);
  assert.ok(boxes.dialog.left >= -1 && boxes.dialog.right <= boxes.width + 1, `dialog fits width ${width}`);
  assert.ok(boxes.footer.bottom <= boxes.height + 1 && boxes.footer.top >= 0, `footer visible at ${width}`);
  assert.ok(boxes.body.bottom <= boxes.footer.top + 1, `footer is outside scrolling body at ${width}`);
  for (const button of boxes.buttons) {
    assert.ok(button.height >= 44 && button.width >= 44, `footer target >=44px at ${width}`);
    assert.ok(button.bottom <= boxes.height + 1 && button.left >= 0 && button.right <= boxes.width + 1, `button fits viewport at ${width}`);
  }
  if (fields) {
    const [amount, date] = boxes.fields;
    if (width > 800) {
      assert.ok(Math.abs(amount.top - date.top) < 2 && date.left >= amount.right - 1, `balance fields side-by-side at ${width}`);
    } else {
      assert.ok(date.top >= amount.bottom - 1 && Math.abs(amount.left - date.left) < 2, `balance fields stacked at ${width}`);
    }
  }
}

test('balance workflows through real Vite frontend and in-memory production router', { timeout: 180000 }, async t => {
  const cacheDir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), 'finance-balance-vite-'));
  const server = await createServer({ configFile: false, cacheDir, server: { host: '127.0.0.1', port: 0, hmr: false } });
  await server.listen();
  t.after(async () => { await server.close(); await rm(cacheDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) });
  t.after(() => browser.close());
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;

  await t.test('Overview reconstructs imported history, reuses cache, and refreshes after another import', async t => {
    const f = await fixture(t, browser, origin);
    const day = daysAgo => new Date(Date.parse(new Date().toISOString().slice(0,10))-daysAgo*86400000).toISOString().slice(0,10);
    const account = await f.create({balanceDate:day(0)}), {page} = f;
    await page.goto(origin+'/dashboard');
    await page.getByRole('heading',{name:'Not enough history yet'}).waitFor();
    await detail(f,origin,account);
    await preview(f,file('recent-history.csv',[
      `${day(4)},Earlier purchase,-20,history-one`,
      `${day(3)},Deposit,100,history-two`,
      `${day(1)},Latest purchase,-25,history-three`,
    ]));
    await page.locator('#import-next').click();
    await page.locator('#account-import-dialog[open]').waitFor({state:'hidden'});
    assert.equal(f.db.prepare('SELECT count(*) n FROM net_worth_history_cache').get().n,0,'import invalidates initial one-point cache');
    await page.goto(origin+'/dashboard');
    await page.locator('.overview-chart').waitFor();
    const history = f.calls.filter(call=>call.path==='/net-worth').at(-1).response;
    assert.equal(history.points.length,5);
    assert.equal(history.history.reconstructedPointCount,4);
    assert.equal(history.points[0].total,925);
    assert.equal(history.points.at(-1).total,1000);
    assert.match(await page.locator('.overview-history-note').innerText(),/reconstruct/i);
    assert.match(await page.locator('.overview-chart').getAttribute('aria-label'),/reconstruct/i);
    const cached = f.db.prepare('SELECT encrypted_data FROM net_worth_history_cache').get().encrypted_data;
    await page.reload(); await page.locator('.overview-chart').waitFor();
    assert.equal(f.db.prepare('SELECT encrypted_data FROM net_worth_history_cache').get().encrypted_data,cached);
    for (const width of [1120,390,320]) {
      await page.setViewportSize({width,height:width===390?875:900});
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
      await screenshot(page,'reconstructed-history',width);
      if(width===390) {
        const geometry = await page.evaluate(()=>({transaction:document.querySelector('#transaction-list .transaction-copy strong').getBoundingClientRect().bottom,navigation:document.querySelector('.mobile-navigation').getBoundingClientRect().top}));
        assert.ok(geometry.transaction<=geometry.navigation,`first transaction description is visible above phone navigation: ${JSON.stringify(geometry)}`);
      }
    }
    await detail(f,origin,account);
    await preview(f,file('correction.csv',[`${day(1)},Additional purchase,-10,history-four`]));
    await page.locator('#import-next').click();
    await page.locator('#account-import-dialog[open]').waitFor({state:'hidden'});
    assert.equal(f.db.prepare('SELECT count(*) n FROM net_worth_history_cache').get().n,0);
    await page.goto(origin+'/dashboard'); await page.locator('.overview-chart').waitFor();
    const corrected = f.calls.filter(call=>call.path==='/net-worth').at(-1).response;
    assert.equal(corrected.points[0].total,935);
    assert.equal(corrected.total,1000,'historical imports do not double-apply against end-of-day anchor');
    assert.notEqual(f.db.prepare('SELECT encrypted_data FROM net_worth_history_cache').get().encrypted_data,cached);
    assert.deepEqual(f.errors,[]);
  });

  await t.test('creation has responsive dated balance fields, safe default zero, cancellation and focus restoration', async t => {
    const f = await fixture(t, browser, origin);
    const { page } = f;
    await page.goto(origin + '/accounts');
    await page.locator('#add-account').click();
    const form = page.locator('#manual-account-form');
    assert.equal(await form.locator('[name=currentBalance]').inputValue(), '0.00');
    assert.equal(await form.locator('[name=balanceDate]').inputValue(), await page.evaluate(() => {
      const now = new Date();
      return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    }));
    await form.locator('[name=accountKind]').selectOption('credit:credit card');
    assert.equal(await form.locator('[name=currentBalance]').locator('..').locator('span').textContent(), 'Amount owed (USD)');
    await form.locator('[name=accountKind]').selectOption('depository:checking');
    assert.equal(await form.locator('[name=currentBalance]').locator('..').locator('span').textContent(), 'Balance (USD)');
    for (const width of [1120, 390, 320]) {
      await page.setViewportSize({ width, height: 760 });
      await geometry(page, '#manual-account-dialog', width, true);
      await screenshot(page, 'create', width);
    }
    await page.locator('#cancel-manual-account').click();
    assert.equal(await page.locator('#manual-account-dialog').evaluate(el => el.open), false);
    assert.equal(await page.locator('#add-account').evaluate(el => el === document.activeElement), true);
    await page.locator('#add-account').click();
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#manual-account-dialog').evaluate(el => el.open), false);
    assert.equal(await page.locator('#add-account').evaluate(el => el === document.activeElement), true);
    assert.equal((await f.accounts()).length, 0, 'cancel and Escape do not write');
    await page.locator('#add-account').click();
    await form.locator('[name=name]').fill('Default-zero checking');
    await form.locator('[name=institutionName]').fill('Example Test Bank');
    await form.locator('button[type=submit]').click();
    await page.locator('#account-balance-options').waitFor();
    const [created] = await f.accounts();
    assert.ok(page.url().endsWith('/accounts/' + created.id), 'creation navigates to detail');
    assert.equal(created.currentBalance, 0);
    assert.equal(created.balanceReference.amount, 0);
    assert.equal(created.balanceReference.verified, false);
    assert.match(await page.locator('.account-detail-balances').innerText(), /Default balance · not verified/);
    assert.doesNotMatch(await page.locator('.account-detail-balances').innerText(), /Available balance/);
    assert.equal(f.calls.find(call => call.method === 'POST' && call.path === '/').request.currentBalance, undefined, 'untouched zero is omitted, not user-verified');
    await page.reload();
    await page.getByText(/Default balance · not verified/).waitFor();
    assert.deepEqual(f.errors, []);
  });

  await t.test('integrated balance options work with touch, keyboard, dismissal and saving at every breakpoint', async t => {
    const f = await fixture(t, browser, origin);
    const account = await f.create();
    const { page } = f;
    for (const width of [1120, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await detail(f, origin, account);
      const options = page.getByRole('button', { name: 'Balance options', exact: true });
      const menu = page.locator('#account-balance-menu');
      assert.equal(await page.locator('.account-detail-balances > div').count(), 1);
      const target = await options.boundingBox();
      assert.ok(target.width >= 44 && target.height >= 44);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await options.focus();
      await page.keyboard.press('Enter');
      await menu.waitFor({ state: 'visible' });
      await poll(() => options.getAttribute('aria-expanded').then(value => value === 'true'), 'expanded state matches open popover');
      const box = await menu.boundingBox();
      assert.ok(box.x >= 0 && box.x + box.width <= width && box.y >= 0 && box.y + box.height <= 900);
      await page.keyboard.press('Escape');
      await menu.waitFor({ state: 'hidden' });
      assert.equal(await options.evaluate(el => el === document.activeElement), true);
      await options.click();
      await page.locator('.account-detail-heading h1').click();
      await menu.waitFor({ state: 'hidden' });
      await options.click();
      await page.keyboard.press('Tab');
      assert.equal(await page.locator('#set-account-balance').evaluate(el => el === document.activeElement), true);
      await page.keyboard.press('Enter');
      await page.locator('#account-balance-dialog[open]').waitFor();
      assert.equal(await menu.isVisible(), false);
      await geometry(page, '#account-balance-dialog', width, true);
      await page.locator('#cancel-account-balance').click();
      await poll(() => options.evaluate(el => el === document.activeElement), 'cancel returns focus');
      await openBalance(page);
      await page.keyboard.press('Escape');
      await poll(() => options.evaluate(el => el === document.activeElement), 'dialog Escape returns focus');
      await openBalance(page);
      await page.locator('#account-balance-form [name=currentBalance]').fill('1234.56');
      await page.locator('#account-balance-form [name=balanceDate]').fill(referenceDate);
      await page.locator('#save-account-balance').click();
      await page.locator('.account-detail-balances strong').filter({ hasText: money(1234.56) }).waitFor();
      assert.equal((await f.saved(account.id)).currentBalance, 1234.56);
      await screenshot(page, 'integrated-options', width);
      await page.locator('#account-balance-options').click();
      await screenshot(page, 'integrated-menu', width);
    }
    assert.deepEqual(f.errors, []);
  });

  await t.test('set balance persists and reanchors saved activity, cancellation, real server failure and retry', async t => {
    const f = await fixture(t, browser, origin);
    const account = await f.create();
    await detail(f, origin, account);
    const { page } = f;
    await openBalance(page);
    const form = page.locator('#account-balance-form');
    await form.locator('[name=currentBalance]').fill('500.25');
    await page.locator('#cancel-account-balance').click();
    await poll(() => page.locator('#account-balance-options').evaluate(el => el === document.activeElement), 'cancel restores visible balance options');
    assert.equal((await f.saved(account.id)).currentBalance, 1000);
    await openBalance(page);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#account-balance-dialog').evaluate(el => el.open), false);
    await poll(() => page.locator('#account-balance-options').evaluate(el => el === document.activeElement), 'Escape restores visible balance options');
    await openBalance(page);
    await form.locator('[name=currentBalance]').fill('500.25');
    await form.locator('[name=balanceDate]').fill(referenceDate);
    f.db.exec("CREATE TRIGGER fail_balance BEFORE UPDATE ON bank_account BEGIN SELECT RAISE(ABORT,'synthetic balance failure'); END");
    await page.locator('#save-account-balance').click();
    await page.locator('#account-balance-error:not([hidden])').waitFor();
    assert.equal(f.calls.filter(call => call.method === 'PATCH').at(-1).status, 500);
    assert.equal((await f.saved(account.id)).currentBalance, 1000, 'failed PATCH does not mutate persisted reference');
    assert.equal(await page.locator('#account-balance-dialog').evaluate(el => el.open), true);
    assert.equal(await form.locator('[name=currentBalance]').inputValue(), '500.25');
    assert.equal(await page.locator('#save-account-balance').isEnabled(), true);
    f.db.exec('DROP TRIGGER fail_balance');
    await page.locator('#save-account-balance').click();
    await page.locator('#account-balance-dialog[open]').waitFor({ state: 'hidden' });
    assert.deepEqual((await f.saved(account.id)).balanceReference, { amount: 500.25, date: referenceDate, verified: true });
    await page.reload();
    await page.locator('.account-detail-balances strong').filter({ hasText: money(500.25) }).waitFor();
    await preview(f);
    await page.locator('#import-next').click();
    await page.locator('#account-import-dialog[open]').waitFor({ state: 'hidden' });
    assert.equal((await f.saved(account.id)).currentBalance, 500.25 - 25 + 100);
    await openBalance(page);
    await page.locator('#account-balance-form [name=currentBalance]').fill('800');
    await page.locator('#account-balance-form [name=balanceDate]').fill('2020-01-16');
    await page.locator('#save-account-balance').click();
    await page.locator('#account-balance-dialog[open]').waitFor({ state: 'hidden' });
    assert.deepEqual((await f.saved(account.id)).balanceReference, { amount: 800, date: '2020-01-16', verified: true });
    assert.equal((await f.saved(account.id)).currentBalance, 800 + 100, 'new end-of-day reference excludes saved transaction on that day');
    await page.reload();
    await page.locator('.account-detail-balances strong').filter({ hasText: money(800 + 100) }).waitFor();
    assert.deepEqual(f.errors, []);
  });

  await t.test('import preview itemizes historical, later and duplicate rows; final balance matches persisted detail', async t => {
    const f = await fixture(t, browser, origin);
    const account = await f.create();
    await detail(f, origin, account);
    const { page } = f;
    const result = await preview(f);
    assert.deepEqual(result.balanceImpact, { referenceBalance: 1000, referenceDate, startingBalance: 1000, historicalCount: 2, appliedCount: 2, appliedAmount: -25 + 100, duplicates: 0, balanceAfterImport: expectedBalance, canApply: true });
    assert.equal(typeof result.previewToken, 'string');
    const impact = page.locator('#import-balance-impact .balance-impact');
    const lines = await impact.locator('dl .balance-impact-row').evaluateAll(rows => rows.map(row => ({ title: row.querySelector('dt').childNodes[0].textContent, value: row.querySelector('dd').textContent })));
    assert.deepEqual(lines, [
      { title: `Reference balance · ${referenceDate}`, value: money(1000) },
      { title: `2 new transactions through ${referenceDate}`, value: 'No change' },
      { title: '2 new later transactions', value: '+' + money(-25 + 100) },
      { title: '0 duplicates', value: money(0) },
      { title: 'Balance after import', value: money(expectedBalance) },
    ]);
    assert.equal(await impact.locator('.balance-impact-total').count(), 1);
    assert.equal((await f.saved(account.id)).currentBalance, 1000, 'preview does not write');
    for (const width of [1120, 390, 320]) {
      await page.setViewportSize({ width, height: 760 });
      await geometry(page, '#account-import-dialog', width);
      await impact.scrollIntoViewIfNeeded();
      await screenshot(page, 'import', width);
    }
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#account-import-dialog').evaluate(el => el.open), false);
    assert.equal(await page.locator('#import-transactions').evaluate(el => el === document.activeElement), true);
    assert.equal((await f.saved(account.id)).currentBalance, 1000, 'Escape from preview does not import');
    await preview(f);
    await page.locator('#import-next').click();
    await page.locator('#account-import-dialog[open]').waitFor({ state: 'hidden' });
    assert.equal((await f.saved(account.id)).currentBalance, expectedBalance);
    const committed = f.calls.filter(call => call.method === 'POST' && call.path.endsWith('/import')).at(-1);
    assert.equal(committed.request.previewToken, result.previewToken);
    const readback = await f.request('/' + account.id + '/transactions', undefined, 'GET');
    assert.equal((await readback.json()).transactions.length, 4, 'historical rows are saved but not double counted');
    await page.locator('.account-detail-balances strong').filter({ hasText: money(expectedBalance) }).waitFor();
    await page.reload();
    await page.locator('#account-balance-options').waitFor();
    const repeated = await preview(f);
    assert.equal(repeated.duplicates, 4);
    assert.equal(repeated.importable, 0);
    assert.equal(repeated.balanceImpact.appliedAmount, 0);
    assert.equal(repeated.balanceImpact.balanceAfterImport, expectedBalance);
    assert.match(await impact.innerText(), /4 duplicates/);
    assert.equal(await page.locator('#import-next').isDisabled(), true);
    assert.equal((await f.saved(account.id)).currentBalance, expectedBalance);
    assert.deepEqual(f.errors, []);
  });

  await t.test('stale preview returns real 409 and requires fresh preview before another commit', async t => {
    const f = await fixture(t, browser, origin);
    const account = await f.create();
    await detail(f, origin, account);
    const first = await preview(f);
    const changed = await f.request('/' + account.id + '/balance', { currentBalance: 2000, balanceDate: referenceDate }, 'PATCH');
    assert.equal(changed.status, 200);
    await f.page.locator('#import-next').click();
    await f.page.locator('#account-import-error:not([hidden])').waitFor();
    const commits = () => f.calls.filter(call => call.path.endsWith('/import') && call.method === 'POST');
    assert.equal(commits().length, 1);
    assert.equal(commits()[0].status, 409);
    assert.equal(f.db.prepare('SELECT count(*) n FROM bank_transaction').get().n, 0);
    assert.equal(await f.page.locator('#import-next').innerText(), 'Preview transactions');
    assert.equal(await f.page.locator('#import-preview-step').isVisible(), false);
    const previewsBefore = f.calls.filter(call => call.path.endsWith('/import/preview')).length;
    await f.page.locator('#import-next').click();
    await f.page.locator('#import-balance-impact .balance-impact').waitFor();
    assert.equal(commits().length, 1, 'retry button previews instead of blindly committing again');
    assert.equal(f.calls.filter(call => call.path.endsWith('/import/preview')).length, previewsBefore + 1);
    const fresh = f.calls.filter(call => call.path.endsWith('/import/preview')).at(-1).response;
    assert.notEqual(fresh.previewToken, first.previewToken);
    assert.equal(fresh.balanceImpact.balanceAfterImport, 2000 - 25 + 100);
    await f.page.locator('#import-next').click();
    await f.page.locator('#account-import-dialog[open]').waitFor({ state: 'hidden' });
    assert.equal(commits().length, 2);
    assert.equal(commits()[1].status, 200);
    assert.equal(commits()[1].request.previewToken, fresh.previewToken);
    assert.equal((await f.saved(account.id)).currentBalance, fresh.balanceImpact.balanceAfterImport);
    assert.deepEqual(f.errors, []);
  });

  await t.test('explicit credit creation uses amount owed and later activity changes liability in the correct direction', async t => {
    const f = await fixture(t, browser, origin);
    const { page } = f;
    await page.goto(origin + '/accounts');
    await page.locator('#add-account').click();
    const form = page.locator('#manual-account-form');
    await form.locator('[name=name]').fill('Synthetic card');
    await form.locator('[name=institutionName]').fill('Example Test Bank');
    await form.locator('[name=accountKind]').selectOption('credit:credit card');
    await form.locator('[name=currentBalance]').fill('1000');
    await form.locator('[name=balanceDate]').fill(referenceDate);
    await form.locator('button[type=submit]').click();
    await page.locator('#account-balance-options').waitFor();
    const [account] = await f.accounts();
    assert.deepEqual(account.balanceReference, { amount: 1000, date: referenceDate, verified: true });
    assert.equal(account.type, 'credit');
    await openBalance(page);
    assert.equal(await page.locator('#account-balance-form [name=currentBalance]').locator('..').locator('span').innerText(), 'Amount owed (USD)');
    await page.keyboard.press('Escape');
    const result = await preview(f);
    assert.equal(result.balanceImpact.appliedAmount, 25 - 100, 'purchase increases owed; payment reduces owed');
    assert.equal(result.balanceImpact.balanceAfterImport, 1000 + 25 - 100);
    await page.locator('#import-next').click();
    await page.locator('#account-import-dialog[open]').waitFor({ state: 'hidden' });
    assert.equal((await f.saved(account.id)).currentBalance, 1000 + 25 - 100);
    await page.reload();
    await page.locator('.account-detail-balances strong').filter({ hasText: money(-(1000 + 25 - 100)) }).waitFor();
    assert.deepEqual(f.errors, []);
  });

  await t.test('batch balance impacts are cumulative per destination and exclude cross-file duplicates', async t => {
    const f = await fixture(t, browser, origin);
    const account = await f.create();
    const { page } = f;
    await page.goto(origin + '/transactions');
    await page.locator('#open-batch-import').click();
    await page.locator('#batch-import-files').setInputFiles([
      file('first.csv', ['01/14/2020,Historical,-20,batch-old', '01/16/2020,Purchase,-25,batch-purchase']),
      file('second.csv', ['01/16/2020,Purchase,-25,batch-purchase', '01/17/2020,Deposit,100,batch-deposit']),
    ]);
    const batchPreviews = () => f.calls.filter(call => call.path === '/import-batch/preview');
    await poll(() => batchPreviews().length > 0, 'initial batch preview arrives');
    for (const index of [0, 1]) {
      const select = page.locator(`[data-batch-account="${index}"]`);
      const before = batchPreviews().length;
      await select.selectOption(account.id);
      await poll(() => batchPreviews().length > before, 'destination selection recalculates batch');
    }
    await page.locator('#batch-balance-impacts .balance-impact').nth(1).waitFor();
    await poll(() => page.locator('#batch-import-confirm').isEnabled(), 'batch ready to import');
    const response = batchPreviews().at(-1).response;
    assert.equal(typeof response.previewToken, 'string');
    assert.equal(response.files.length, 2);
    assert.equal(response.files[0].balanceImpact.historicalCount, 1);
    assert.equal(response.files[0].balanceImpact.balanceAfterImport, 1000 - 25);
    assert.equal(response.files[1].balanceImpact.startingBalance, 1000 - 25);
    assert.equal(response.files[1].balanceImpact.duplicates, 1);
    assert.equal(response.files[1].balanceImpact.balanceAfterImport, expectedBalance);
    assert.deepEqual(await page.locator('#batch-balance-impacts .balance-impact-total dd').allTextContents(), [money(1000 - 25), money(expectedBalance)]);
    assert.match(await page.locator('#batch-balance-impacts').innerText(), /Previously imported later activity/);
    assert.equal((await f.saved(account.id)).currentBalance, 1000, 'batch preview has no writes');
    await page.locator('#batch-import-confirm').click();
    await page.locator('#batch-import-dialog[open]').waitFor({ state: 'hidden' });
    const commit = f.calls.find(call => call.path === '/import-batch' && call.method === 'POST');
    assert.equal(commit.status, 200);
    assert.equal(commit.request.previewToken, response.previewToken);
    assert.equal(commit.response.imported, 3);
    assert.equal(commit.response.skipped, 1);
    assert.equal((await f.saved(account.id)).currentBalance, expectedBalance);
    assert.equal(f.db.prepare('SELECT count(*) n FROM bank_transaction').get().n, 3);
    await detail(f, origin, account);
    await page.locator('.account-detail-balances strong').filter({ hasText: money(expectedBalance) }).waitFor();
    assert.deepEqual(f.errors, []);
  });

  await t.test('legacy unknown balance remains unset until explicitly anchored', async t => {
    const f = await fixture(t, browser, origin);
    const account = await f.create();
    const row = f.db.prepare('SELECT encrypted_data FROM bank_account WHERE id=?').get(account.id);
    const snapshot = JSON.parse(decryptBankValue(row.encrypted_data, key));
    delete snapshot.balanceReference;
    snapshot.currentBalance = null;
    f.db.prepare('UPDATE bank_account SET encrypted_data=? WHERE id=?').run(encryptBankValue(JSON.stringify(snapshot), key), account.id);
    await detail(f, origin, account);
    assert.match(await f.page.locator('.account-detail-balances').innerText(), /Balance not set/);
    assert.doesNotMatch(await f.page.locator('.account-detail-balances').innerText(), /Available balance|Default balance/);
    await openBalance(f.page);
    await f.page.locator('#account-balance-form [name=currentBalance]').fill('0');
    await f.page.locator('#account-balance-form [name=balanceDate]').fill(referenceDate);
    await f.page.locator('#save-account-balance').click();
    await f.page.locator('#account-balance-dialog[open]').waitFor({ state: 'hidden' });
    assert.deepEqual((await f.saved(account.id)).balanceReference, { amount: 0, date: referenceDate, verified: true });
    await f.page.reload();
    await f.page.locator('#account-balance-options').waitFor();
    assert.match(await f.page.locator('.account-detail-balances').innerText(), /\$0\.00/);
    assert.doesNotMatch(await f.page.locator('.account-detail-balances').innerText(), /Balance not set|not verified/);
    assert.deepEqual(f.errors, []);
  });
});
