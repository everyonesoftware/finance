import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'vite';
import { Hono } from 'hono';
import { registerStaticRoutes } from '../server/static-serving.ts';

test('production build is a regular web app without install or offline artifacts', async () => {
  const dir = await mkdtemp(join(process.env.TMPDIR || tmpdir(), 'finance-web-'));
  try {
    await build({ configFile: resolve('vite.config.ts'), logLevel: 'silent', build: { outDir: dir, emptyOutDir: true } });
    const html = await readFile(join(dir, 'index.html'), 'utf8');
    assert.doesNotMatch(html, /rel="manifest"|apple-touch-icon|apple-mobile-web-app-capable/);
    for (const file of ['manifest.webmanifest', 'offline.html', 'version.json', 'icons/finance-512.png']) {
      await assert.rejects(readFile(join(dir, file)), { code: 'ENOENT' }, file);
    }
    const app = new Hono();
    app.get('/api/private', c => c.json({ error: 'Unauthorized' }, 401));
    registerStaticRoutes(app, dir);
    const retirement = await app.request('/sw.js');
    assert.equal(retirement.status, 200);
    assert.match(retirement.headers.get('Content-Type'), /javascript/);
    assert.match(retirement.headers.get('Cache-Control'), /no-cache|no-store/);
    assert.equal(await retirement.text(), await readFile(new URL('../public/sw.js', import.meta.url), 'utf8'));
    for (const path of ['/', '/settings', '/dashboard', '/transactions', '/accounts/demo-checking']) {
      for (const method of ['GET', 'HEAD']) {
        const response = await app.request(path, { method, headers: { Accept: 'text/html', 'Sec-Fetch-Dest': 'document' } });
        assert.equal(response.status, 200, `${method} ${path}`);
        assert.match(response.headers.get('Cache-Control'), /no-cache|no-store/);
        if (method === 'HEAD') assert.equal(await response.text(), '');
        else assert.match(await response.text(), /<div id="app">/);
      }
    }
    for (const path of ['/api', '/api/missing', '/assets/missing', '/icons/missing.png', '/missing.js', '/offline.html', '/manifest.webmanifest', '/version.json']) {
      assert.equal((await app.request(path)).status, 404, path);
    }
    for (const destination of ['script', 'style', 'image']) {
      assert.equal((await app.request('/settings', { headers: { Accept: 'text/html', 'Sec-Fetch-Dest': destination } })).status, 404);
    }
    assert.equal((await app.request('/api/private')).status, 401);
    assert.equal((await app.request('/%61pi/private')).status, 401);
    assert.equal((await app.request('/settings', { method: 'POST' })).status, 404);
    assert.equal((await app.request('/settings', { headers: { Accept: 'application/json' } })).status, 404);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
