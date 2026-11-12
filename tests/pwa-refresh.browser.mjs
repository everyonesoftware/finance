import assert from 'node:assert/strict';
import { test } from 'node:test';
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { chromium } from 'playwright';
import { registerStaticRoutes } from '../server-dist/static-serving.js';

// Exercise the production router and built worker together, without private data or APIs.
for (const mobile of [false, true]) {
  test(`service-worker-controlled refresh serves deep links (${mobile ? 'mobile' : 'desktop'})`, async () => {
    const directory = await mkdtemp(join(process.env.TMPDIR || tmpdir(), 'finance-refresh-'));
    let browser;
    let server;
    try {
      await writeFile(join(directory, 'index.html'), '<!doctype html><title>Finance refresh fixture</title><h1>Finance</h1>');
      for (const file of ['sw.js', 'offline.html']) {
        await copyFile(resolve('dist', file), join(directory, file));
      }
      const requests = [];
      const app = new Hono();
      app.use('*', async (context, next) => {
        await next();
        requests.push({ path: context.req.path, destination: context.req.header('Sec-Fetch-Dest'), status: context.res.status });
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
      const page = await context.newPage();
      await page.goto(origin);
      await page.evaluate(async () => {
        await navigator.serviceWorker.register('/sw.js');
        await navigator.serviceWorker.ready;
      });
      await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
      for (const path of ['/settings', '/dashboard', '/transactions', '/accounts/demo-checking']) {
        assert.equal((await page.goto(origin + path)).status(), 200, `controlled navigation ${path}`);
        assert.equal((await page.reload()).status(), 200, `controlled refresh ${path}`);
        assert.equal(await page.title(), 'Finance refresh fixture');
        assert.ok(requests.some(request => request.path === path && request.destination === 'empty' && request.status === 200), `worker must forward ${path} through the production router`);
      }
      for (const path of ['/api/missing', '/assets/missing.js']) {
        assert.equal((await page.goto(origin + path)).status(), 404, path);
      }
    } finally {
      await browser?.close();
      if (server) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  });
}
