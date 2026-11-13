import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { applySqlMigration } from '../server/migration-utils.ts';

// No server/index.ts, auth configuration, .env, file database, or provider API.
// All successful settings requests use the real Hono router and migrated SQLite.
// Only auth and explicit transport failures are fixtures. Never log request keys.
const owner = 'twelve-settings-browser-owner';
const encryptionKey = Buffer.alloc(32, 23);
const syntheticKeys = ['synthetic-twelve-browser-first-only', 'synthetic-twelve-browser-replacement-only'];
const endpoint = '/api/settings/twelve-data';
const scratch = join(process.env.LOCALAPPDATA ?? tmpdir(), 'hermes', 'cache', 'scratch');
const screenshotDir = join(scratch, 'finance-twelve-data-browser');
const ids = name => '#twelve-data-' + name;

async function until(check, message) {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  assert.fail(message);
}

async function status(page, expected) {
  await until(async () => (await page.locator(ids('status')).textContent())?.trim() === expected,
    `Twelve Data status reaches ${expected}`);
}

async function noSecret(page) {
  // Boolean assertions keep synthetic secrets out of assertion diagnostics.
  const safe = await page.evaluate(keys => {
    const storage = JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } });
    return keys.every(key => !document.body.innerHTML.includes(key)
      && !document.body.innerText.includes(key) && !storage.includes(key)
      && ![...document.querySelectorAll('input')].some(input => input.value.includes(key)));
  }, syntheticKeys);
  assert.equal(safe, true, 'saved credentials are absent from DOM, input values, and browser storage');
  assert.equal(await page.locator(ids('key')).inputValue(), '', 'saved key is never repopulated');
}

async function geometry(page, width, image = false) {
  await page.setViewportSize({ width, height: 900 });
  const panel = page.locator(ids('panel'));
  await panel.scrollIntoViewIfNeeded();
  const result = await panel.evaluate(panel => {
    const rect = node => { const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width, height: r.height }; };
    const visible = node => node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden';
    return {
      viewport: innerWidth,
      pageOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      panelOverflow: panel.scrollWidth > panel.clientWidth,
      panel: rect(panel),
      targets: [...panel.querySelectorAll('button,input')].filter(visible).map(node => ({ id: node.id, ...rect(node) })),
    };
  });
  if (image && [1120, 390].includes(width)) {
    await mkdir(screenshotDir, { recursive: true });
    await panel.screenshot({ path: join(screenshotDir, `twelve-data-saved-${width}.png`) });
  }
  assert.equal(result.pageOverflow, false, `no page horizontal overflow at ${width}`);
  assert.equal(result.panelOverflow, false, `no panel horizontal overflow at ${width}`);
  assert.ok(result.panel.left >= -1 && result.panel.right <= width + 1, `panel fits ${width}`);
  assert.ok(result.targets.length >= 2, 'input and save target are measured');
  for (const target of result.targets) {
    assert.ok(target.width >= 44 && target.height >= 44, `${target.id} target ${target.width}x${target.height}px must be at least 44px at ${width}`);
    assert.ok(target.left >= -1 && target.right <= result.viewport + 1, `panel target fits ${width}`);
  }
}

async function fixture(t, browser, origin, createRouter) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys=ON');
  t.after(() => db.close());
  const migrations = new URL('../server/migrations/', import.meta.url);
  for (const name of (await readdir(migrations)).filter(name => name.endsWith('.sql')).sort()) {
    applySqlMigration(db, await readFile(new URL(name, migrations), 'utf8'));
  }
  db.prepare('INSERT INTO user(id,name,email) VALUES(?,?,?)').run(owner, 'Synthetic Settings User', 'twelve-browser@example.test');
  const control = { failure: null, hold: null, encryptionFailure: false };
  const router = createRouter({
    database: db, getUserId: async () => owner,
    getEncryptionKey: () => {
      if (control.encryptionFailure) throw new Error('Synthetic encryption unavailable');
      return encryptionKey;
    },
    trustedOrigins: [origin],
  });
  const request = (method, body) => router.request(new Request(origin + '/', {
    method, headers: { 'content-type': 'application/json', origin },
    ...(['GET', 'HEAD'].includes(method) ? {} : { body: JSON.stringify(body) }),
  }));
  const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1120, height: 900 }, serviceWorkers: 'block' });
  t.after(() => context.close());
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.setDefaultNavigationTimeout(30000);
  const errors = [], external = [], unexpected = [], calls = [], held = [];
  page.on('pageerror', error => errors.push(error.name));
  t.after(() => { for (const release of held) release(); });
  // The guard also catches non-API browser requests (including analytics/CDNs).
  await context.route('**/*', async route => {
    const incoming = route.request();
    const url = new URL(incoming.url());
    if (url.origin !== origin) {
      external.push(url.origin); // Deliberately never record URL query strings.
      return route.abort('blockedbyclient');
    }
    if (!url.pathname.startsWith('/api/')) return route.continue();
    if (url.pathname === '/api/auth/get-session') {
      return route.fulfill({ json: {
        user: { id: owner, name: 'Synthetic Settings User', username: 'synthetic', email: 'twelve-browser@example.test', emailVerified: true, createdAt: '2020-01-01T00:00:00Z', updatedAt: '2020-01-01T00:00:00Z' },
        session: { id: 'synthetic-settings-session', userId: owner, token: 'synthetic-session', expiresAt: '2099-01-01T00:00:00Z' },
      } });
    }
    if (url.pathname !== endpoint && url.pathname !== endpoint + '/') {
      unexpected.push(url.pathname);
      return route.fulfill({ status: 404, json: { error: 'Unexpected test API request' } });
    }
    const method = incoming.method();
    const body = incoming.postDataJSON();
    const call = { method, requestKeys: body ? Object.keys(body) : [], jsonEmpty: body !== null && JSON.stringify(body) === '{}', safeURL: !syntheticKeys.some(key => incoming.url().includes(key)) };
    if (method === 'PUT') call.syntheticCredential = syntheticKeys.includes(body?.apiKey);
    calls.push(call);
    let response;
    if (control.failure === method) {
      control.failure = null;
      response = new Response(JSON.stringify({ error: 'Synthetic temporary settings failure' }), { status: 503, headers: { 'content-type': 'application/json' } });
    } else {
      response = await router.request(new Request(origin + '/' + url.search, {
        method, headers: await incoming.allHeaders(),
        ...(['GET', 'HEAD'].includes(method) ? {} : { body: incoming.postDataBuffer() }),
      }));
    }
    const text = await response.text();
    call.status = response.status;
    call.responseSafe = !syntheticKeys.some(key => text.includes(key));
    call.response = call.responseSafe ? JSON.parse(text) : { unsafe: true };
    if (control.hold === method) {
      control.hold = null;
      await new Promise(resolve => { held.push(resolve); call.release = resolve; });
    }
    try {
      await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: text });
    } catch (error) {
      // Navigation/AbortController may cancel the deliberately held request.
      if (!call.release) throw error;
      call.cancelled = true;
    }
    call.finished = true;
  });
  const verify = () => {
    assert.deepEqual(errors, [], 'no uncaught browser errors');
    assert.deepEqual(external, [], 'browser never requests an external origin');
    assert.deepEqual(unexpected, [], 'Settings uses only auth and the settings endpoint');
    assert.ok(calls.every(call => call.responseSafe && call.safeURL), 'no credential in responses or request URLs');
    assert.ok(calls.filter(call => call.method === 'GET' && call.status === 200)
      .every(call => Object.keys(call.response).join(',') === 'configured' && typeof call.response.configured === 'boolean'), 'GET returns configured boolean only');
  };
  return { page, db, calls, control, request, verify };
}

// This runs the actual index.html -> src/main.ts Settings route, not a harness
// rendering the standalone panel. Vite uses a fresh cache and no project config.
test('Twelve Data Settings through Vite, production Hono, and migrated in-memory SQLite', { timeout: 180000 }, async t => {
  const { createTwelveDataSettingsRouter } = await import('../server/twelve-data-settings.ts');
  assert.equal(typeof createTwelveDataSettingsRouter, 'function');
  await mkdir(scratch, { recursive: true });
  const cacheDir = await mkdtemp(join(scratch, 'finance-twelve-vite-'));
  t.after(() => rm(cacheDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const server = await createServer({ configFile: false, cacheDir, envFile: false, server: { host: '127.0.0.1', port: 0, hmr: false } });
  t.after(() => server.close());
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  const browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) });
  t.after(() => browser.close());
  // A provider request made by the production server router must fail this test,
  // even though page interception would not see it. No real network is allowed.
  const realFetch = globalThis.fetch;
  const serverRequests = [];
  globalThis.fetch = async () => { serverRequests.push('blocked'); throw new Error('External fetch forbidden in settings browser test'); };
  t.after(() => { globalThis.fetch = realFetch; assert.deepEqual(serverRequests, [], 'router never makes provider requests'); });

  await t.test('loading, save, reload, replacement, removal, and responsive privacy', async t => {
    const f = await fixture(t, browser, origin, createTwelveDataSettingsRouter);
    const { page } = f;
    f.control.hold = 'GET';
    await page.goto(origin + '/settings');
    await page.locator(ids('panel')).waitFor();
    await until(() => f.calls.some(call => call.release), 'initial GET is held');
    await status(page, 'Loading…');
    assert.equal(await page.locator(ids('form')).count(), 1);
    assert.equal(await page.locator(ids('key')).getAttribute('type'), 'password');
    assert.equal(await page.locator(ids('key')).isDisabled(), true);
    assert.equal(await page.locator(ids('save')).isDisabled(), true);
    assert.equal(await page.locator(ids('remove')).isVisible(), false);
    assert.equal(await page.locator(ids('retry')).isVisible(), false);
    assert.equal(await page.evaluate(() => {
      const update = document.querySelector('#update-title')?.closest('section');
      return update?.nextElementSibling?.id === 'twelve-data-panel';
    }), true, 'Twelve Data panel follows App updates');
    f.calls.find(call => call.release).release();
    await status(page, 'Not configured');
    assert.equal(await page.locator(ids('key')).isEnabled(), true);
    assert.equal((await page.locator(ids('save')).innerText()).trim(), 'Save API key');
    for (const width of [1120, 390, 320]) await t.test(`unconfigured layout ${width}`, () => geometry(page, width));
    await page.locator(ids('key')).fill(syntheticKeys[0]);
    await page.locator(ids('save')).click();
    await status(page, 'Key saved · not verified');
    await noSecret(page);
    assert.equal((await page.locator(ids('save')).innerText()).trim(), 'Replace API key');
    assert.equal(await page.locator(ids('remove')).isVisible(), true);
    assert.equal(f.calls.filter(call => call.method === 'PUT').length, 1);
    assert.equal(f.calls.find(call => call.method === 'PUT').syntheticCredential, true);
    assert.deepEqual(f.calls.find(call => call.method === 'PUT').requestKeys, ['apiKey']);
    assert.deepEqual(f.calls.find(call => call.method === 'PUT').response, { configured: true });
    assert.equal(syntheticKeys.some(key => f.db.serialize().includes(Buffer.from(key))), false, 'SQLite has no plaintext key');
    for (const width of [1120, 390, 320]) await t.test(`configured layout ${width}`, () => geometry(page, width, true));
    await page.reload();
    await status(page, 'Key saved · not verified');
    await noSecret(page);
    await page.locator(ids('key')).fill(syntheticKeys[1]);
    await page.locator(ids('save')).click();
    await until(() => f.calls.filter(call => call.method === 'PUT' && call.status === 200 && call.finished).length === 2, 'replacement completes');
    await status(page, 'Key saved · not verified');
    await noSecret(page);
    await page.reload();
    await status(page, 'Key saved · not verified');
    await noSecret(page);
    await page.locator(ids('remove')).click();
    await status(page, 'Not configured');
    assert.equal(await page.locator(ids('remove')).isVisible(), false);
    assert.equal((await page.locator(ids('save')).innerText()).trim(), 'Save API key');
    const removal = f.calls.find(call => call.method === 'DELETE');
    assert.equal(removal.jsonEmpty, true, 'DELETE sends JSON {}');
    assert.deepEqual(removal.response, { configured: false });
    await page.reload();
    await status(page, 'Not configured');
    await noSecret(page);
    f.verify();
  });

  await t.test('load failure disables form and retry recovers; failed writes preserve configuration', async t => {
    const f = await fixture(t, browser, origin, createTwelveDataSettingsRouter);
    const { page } = f;
    f.control.failure = 'GET';
    await page.goto(origin + '/settings');
    await page.locator(ids('retry')).waitFor({ state: 'visible' });
    assert.equal(await page.locator(ids('key')).isDisabled(), true);
    assert.equal(await page.locator(ids('save')).isDisabled(), true);
    assert.equal(await page.locator(ids('message')).isVisible(), true);
    assert.ok((await page.locator(ids('message')).innerText()).trim().length > 0);
    for (const width of [1120, 390, 320]) await t.test(`load-error layout ${width}`, () => geometry(page, width));
    await page.locator(ids('retry')).click();
    await status(page, 'Not configured');
    assert.equal(await page.locator(ids('retry')).isVisible(), false);
    f.control.encryptionFailure = true;
    await page.locator(ids('key')).fill(syntheticKeys[0]);
    await page.locator(ids('save')).click();
    await until(() => f.calls.some(call => call.method === 'PUT' && call.status === 500), 'real production encryption failure returns 500');
    await page.locator(ids('message')).waitFor({ state: 'visible' });
    await until(() => page.locator(ids('key')).isEnabled(), 'failed save re-enables entry');
    assert.deepEqual(await (await f.request('GET')).json(), { configured: false });
    await status(page, 'Not configured');
    assert.equal(await page.locator(ids('remove')).isVisible(), false);
    f.control.encryptionFailure = false;
    await page.locator(ids('key')).fill(syntheticKeys[0]);
    await page.locator(ids('save')).click();
    await status(page, 'Key saved · not verified');
    await noSecret(page);
    f.control.failure = 'DELETE';
    await page.locator(ids('remove')).click();
    await until(() => f.calls.some(call => call.method === 'DELETE' && call.status === 503), 'remove failure received');
    await page.locator(ids('message')).waitFor({ state: 'visible' });
    await until(() => page.locator(ids('remove')).isEnabled(), 'failed removal can be retried');
    assert.deepEqual(await (await f.request('GET')).json(), { configured: true });
    await status(page, 'Key saved · not verified');
    await noSecret(page);
    await page.locator(ids('remove')).click();
    await status(page, 'Not configured');
    f.verify();
  });

  await t.test('late GET after Settings detaches cannot overwrite a newly mounted panel', async t => {
    const f = await fixture(t, browser, origin, createTwelveDataSettingsRouter);
    const { page } = f;
    f.control.hold = 'GET';
    await page.goto(origin + '/settings');
    await status(page, 'Loading…');
    await until(() => f.calls.some(call => call.release), 'old GET response is held');
    const old = f.calls.find(call => call.release);
    assert.deepEqual(old.response, { configured: false });
    const saved = await f.request('PUT', { apiKey: syntheticKeys[0] });
    assert.equal(saved.status, 200);
    // Popstate uses main.ts's real router and aborts the previous page lifetime.
    await page.evaluate(() => {
      window.__oldTwelvePanel = document.querySelector('#twelve-data-panel');
      dispatchEvent(new PopStateEvent('popstate'));
    });
    await status(page, 'Key saved · not verified');
    old.release();
    await until(() => old.finished, 'late transport settles, or observes cancellation');
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await status(page, 'Key saved · not verified');
    assert.equal(await page.evaluate(() => !window.__oldTwelvePanel.isConnected), true);
    await noSecret(page);
    assert.equal(await page.locator(ids('remove')).isEnabled(), true);
    f.verify();
  });
});
