import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { chromium } from 'playwright';
import { registerStaticRoutes } from '../server-dist/static-serving.js';

// Only the fixture installs the legacy worker. Production pages never register one.
const legacyWorker = `
self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', event => {
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).catch(() => caches.match('/offline.html')));
  }
});
`;
const fixtureHtml = '<!doctype html><title>Finance retirement fixture</title><h1>Finance</h1><input id="draft" aria-label="Unsaved draft">';

for (const mobile of [false, true]) {
  test(`legacy worker retires without reload or data loss (${mobile ? 'mobile' : 'desktop'})`, { timeout: 60000 }, async () => {
    const directory = await mkdtemp(join(process.env.TMPDIR || tmpdir(), 'finance-retirement-'));
    let browser;
    let server;
    try {
      const retirementWorker = await readFile(resolve(process.env.FINANCE_BROWSER_DIST ?? 'dist', 'sw.js'), 'utf8');
      await writeFile(join(directory, 'index.html'), fixtureHtml);
      await writeFile(join(directory, 'sw.js'), legacyWorker);
      const requests = [];
      const app = new Hono();
      app.use('*', async (context, next) => {
        await next();
        requests.push({ path: context.req.path, status: context.res.status });
      });
      registerStaticRoutes(app, directory);
      server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
      await new Promise(resolve => server.listening ? resolve() : server.once('listening', resolve));
      const origin = `http://127.0.0.1:${server.address().port}`;
      browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL || process.platform === 'win32' ? { channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge' } : {}) });
      const context = await browser.newContext({
        serviceWorkers: 'allow',
        viewport: mobile ? { width: 412, height: 915 } : { width: 1440, height: 960 },
        isMobile: mobile,
        hasTouch: mobile,
      });
      const errors = [];
      const first = await context.newPage();
      await first.goto(origin + '/settings');
      await first.evaluate(async () => {
        await navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' });
        await navigator.serviceWorker.ready;
      });
      await first.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
      const second = await context.newPage();
      await second.goto(origin + '/transactions');
      await second.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
      let navigations = 0;
      for (const [index, page] of [first, second].entries()) {
        page.on('pageerror', error => errors.push(error.message));
        page.on('framenavigated', frame => { if (frame === page.mainFrame()) navigations++; });
        await page.locator('#draft').fill(`unsaved draft ${index}`);
        await page.evaluate(async index => {
          window.documentIdentity = `original-${index}`;
          localStorage.setItem('finance-fixture-preference', 'preserve');
          sessionStorage.setItem('finance-fixture-session', `session-${index}`);
          const db = await new Promise((resolve, reject) => {
            const request = indexedDB.open('finance-retirement-fixture', 1);
            request.onupgradeneeded = () => request.result.createObjectStore('drafts');
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
          await new Promise((resolve, reject) => {
            const transaction = db.transaction('drafts', 'readwrite');
            transaction.objectStore('drafts').put('keep financial draft', 'draft');
            transaction.oncomplete = resolve;
            transaction.onerror = () => reject(transaction.error);
          });
          db.close();
        }, index);
      }
      await first.evaluate(async () => {
        for (const name of ['finance-pwa-offline-old', 'finance-pwa-offline-older', 'unrelated-cache']) {
          const cache = await caches.open(name);
          await cache.put('/offline.html', new Response('Legacy offline fixture'));
        }
      });
      await writeFile(join(directory, 'sw.js'), retirementWorker);

      // Simulate a browser update check on an EXISTING registration only.
      // No activation message: install/skipWaiting must handle this automatically.
      await first.evaluate(async () => {
        const registration = await navigator.serviceWorker.getRegistration();
        const replacementActivated = new Promise((resolve, reject) => {
          registration.addEventListener('updatefound', () => {
            const replacement = registration.installing;
            const check = () => {
              if (replacement.state === 'activated') resolve();
              if (replacement.state === 'redundant') reject(new Error('Retirement worker became redundant before activation'));
            };
            replacement.addEventListener('statechange', check);
            check();
          }, { once: true });
        });
        await registration.update();
        await replacementActivated;
      });
      // Waiting for the exact replacement matters: the old controller can be
      // activated while getRegistrations() transiently hides its replacement.
      await first.waitForFunction(async () => (await navigator.serviceWorker.getRegistrations()).length === 0);
      assert.equal(navigations, 0, 'retirement must not navigate or reload either open tab');
      assert.deepEqual(await first.evaluate(() => caches.keys()), ['unrelated-cache'], 'delete only Finance offline caches');
      assert.equal(await first.evaluate(async () => (await (await caches.open('unrelated-cache')).match('/offline.html')).text()), 'Legacy offline fixture');
      for (const [index, page] of [first, second].entries()) {
        assert.equal(await page.locator('#draft').inputValue(), `unsaved draft ${index}`, 'unsaved form survives');
        assert.equal(await page.evaluate(() => window.documentIdentity), `original-${index}`, 'document is not replaced');
        assert.equal(await page.evaluate(() => localStorage.getItem('finance-fixture-preference')), 'preserve');
        assert.equal(await page.evaluate(() => sessionStorage.getItem('finance-fixture-session')), `session-${index}`);
        assert.equal(await page.evaluate(async () => {
          const db = await new Promise((resolve, reject) => {
            const request = indexedDB.open('finance-retirement-fixture');
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
          const value = await new Promise((resolve, reject) => {
            const request = db.transaction('drafts').objectStore('drafts').get('draft');
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
          db.close();
          return value;
        }), 'keep financial draft', 'IndexedDB survives');
        // Existing documents may retain a controller until next navigation.
        assert.equal(await page.evaluate(() => navigator.serviceWorker.controller?.scriptURL.endsWith('/sw.js')), true);
      }
      await context.setOffline(true);
      await assert.rejects(first.evaluate(() => fetch('/dashboard', { cache: 'no-store' }).then(response => response.text())), /Failed to fetch/);
      // Use a controlled tab: unregistration alone does not prove that the
      // replacement worker stopped serving the legacy offline fallback.
      await assert.rejects(first.goto(origin + '/dashboard'), /net::ERR_(INTERNET_DISCONNECTED|FAILED)/);
      await context.setOffline(false);
      for (const path of ['/settings', '/dashboard', '/transactions', '/accounts/demo-checking']) {
        assert.equal((await first.goto(origin + path)).status(), 200, `ordinary navigation ${path}`);
        assert.equal((await first.reload()).status(), 200, `ordinary refresh ${path}`);
        assert.equal(await first.title(), 'Finance retirement fixture');
        assert.equal(await first.evaluate(() => navigator.serviceWorker.controller), null, 'next navigation is uncontrolled');
      }
      for (const path of ['/api/missing', '/assets/missing.js']) {
        assert.equal((await first.goto(origin + path)).status(), 404, path);
      }
      assert.deepEqual(await second.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).map(registration => registration.scope)), []);
      assert.ok(requests.some(request => request.path === '/sw.js' && request.status === 200), 'production router serves worker update');
      assert.deepEqual(errors, [], 'no browser runtime errors during retirement');
    } finally {
      await browser?.close();
      if (server) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  });
}
