import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'vite';
import { runInNewContext } from 'node:vm';
import { Hono } from 'hono';

async function workerHarness(dir, options = {}) {
  const handlers = new Map();
  const entries = new Map();
  const deleted = [];
  const requests = [];
  let skipped = 0;
  let claimed = 0;
  const cache = {
    put: async (key, value) => entries.set(typeof key === 'string' ? key : key.url, value),
    match: async key => entries.get(typeof key === 'string' ? key : key.url),
  };
  const self = {
    location: { origin: 'https://finance.test' },
    clients: { claim: async () => { claimed++; } },
    skipWaiting: async () => { skipped++; },
    addEventListener: (type, handler) => handlers.set(type, handler),
  };
  runInNewContext(await readFile(join(dir, 'sw.js'), 'utf8'), {
    self, URL, Request, Response,
    caches: {
      open: async () => cache,
      keys: async () => ['another-app-cache', 'finance-pwa-offline-old', ...options.extraCaches || []],
      delete: async name => { deleted.push(name); return true; },
    },
    fetch: async (request, init) => {
      requests.push({ request, init });
      if (options.offline) throw new TypeError('Network disconnected');
      return new Response(options.body || '<h1>Public offline page</h1>', {
        status: options.status || 200, headers: { 'Content-Type': 'text/html' },
      });
    },
  });
  return {
    entries, deleted, requests,
    get skipped() { return skipped; },
    get claimed() { return claimed; },
    async dispatch(type, data = {}) {
      let result;
      const pending = [];
      handlers.get(type)?.({ ...data, waitUntil: promise => pending.push(promise), respondWith: promise => { result = promise; } });
      await Promise.all(pending);
      return result;
    },
    async fetch(path, method = 'GET', mode = 'navigate') {
      return this.dispatch('fetch', { request: { url: new URL(path, self.location.origin).href, method, mode } });
    },
  };
}

async function generator() {
  const path = new URL('../build/pwa.ts', import.meta.url);
  try { await readFile(path); } catch { assert.fail('PWA build generator must exist'); }
  return import(path.href);
}

async function fixture(run) {
  const dir = await mkdtemp(join(process.env.TMPDIR || tmpdir(), 'finance-pwa-'));
  try {
    await mkdir(join(dir, 'assets'));
    await writeFile(join(dir, 'index.html'), '<html>Finance</html>');
    await writeFile(join(dir, 'assets/app.js'), 'console.log("app")');
    await writeFile(join(dir, 'offline.html'), '<h1>Disconnected</h1>');
    await run(dir);
  } finally { await rm(dir, { recursive: true, force: true }); }
}

test('build metadata preserves display version and fingerprints every output byte deterministically', async () => {
  const { writePwaArtifacts } = await generator();
  await fixture(async dir => {
    const first = await writePwaArtifacts(dir, 'dev');
    assert.equal(first.version, 'dev');
    assert.match(first.buildId, /^[a-f0-9]{64}$/);
    assert.deepEqual(JSON.parse(await readFile(join(dir, 'version.json'), 'utf8')), first);
    const worker = await readFile(join(dir, 'sw.js'), 'utf8');
    assert.ok(worker.includes(first.buildId));
    assert.deepEqual(await writePwaArtifacts(dir, 'dev'), first);
    await writeFile(join(dir, 'assets/app.js'), 'console.log("changed")');
    const changed = await writePwaArtifacts(dir, 'dev');
    assert.notEqual(changed.buildId, first.buildId);
    assert.notEqual(await readFile(join(dir, 'sw.js'), 'utf8'), worker);
    await writeFile(join(dir, 'offline.html'), '<h1>New offline page</h1>');
    assert.notEqual((await writePwaArtifacts(dir, 'dev')).buildId, changed.buildId);
    const release = await writePwaArtifacts(dir, 'v1.2.3');
    assert.equal(release.version, 'v1.2.3');
    assert.notEqual(release.buildId, changed.buildId);
  });
});

test('worker caches only the public disconnected page and waits for explicit activation', async () => {
  const { writePwaArtifacts } = await generator();
  await fixture(async dir => {
    await writePwaArtifacts(dir, 'dev');
    const worker = await workerHarness(dir);
    await worker.dispatch('install');
    assert.deepEqual([...worker.entries.keys()], ['/offline.html']);
    assert.equal(worker.requests.length, 1);
    assert.equal(worker.requests[0].init.credentials, 'omit');
    assert.equal(worker.skipped, 0);
    await worker.dispatch('activate');
    assert.deepEqual(worker.deleted, ['finance-pwa-offline-old']);
    assert.equal(worker.claimed, 1);
    await worker.dispatch('message', { data: { type: 'OTHER' } });
    await worker.dispatch('message', { data: null });
    assert.equal(worker.skipped, 0);
    await worker.dispatch('message', { data: { type: 'SKIP_WAITING' } });
    assert.equal(worker.skipped, 1);
  });
});

test('worker never intercepts APIs, mutations, cross-origin requests or dashboard bundles', async () => {
  const { writePwaArtifacts } = await generator();
  await fixture(async dir => {
    await writePwaArtifacts(dir, 'dev');
    const worker = await workerHarness(dir, { offline: true });
    for (const path of ['/api', '/api/accounts', '/api/auth/sign-in', '/%61pi/accounts']) {
      assert.equal(await worker.fetch(path), undefined, path);
    }
    assert.equal(await worker.fetch('/accounts', 'POST'), undefined);
    assert.equal(await worker.fetch('https://other.test/accounts'), undefined);
    assert.equal(await worker.fetch('/assets/app.js', 'GET', 'cors'), undefined);
    assert.equal(await worker.fetch('/version.json', 'GET', 'cors'), undefined);
    assert.equal(worker.requests.length, 0);
    assert.equal(worker.entries.size, 0);
  });
});

test('navigation is network-first without saving responses, falling back only on network failure', async () => {
  const { writePwaArtifacts } = await generator();
  await fixture(async dir => {
    await writePwaArtifacts(dir, 'dev');
    const online = await workerHarness(dir, { body: 'Authenticated network HTML' });
    assert.equal(await (await online.fetch('/accounts')).text(), 'Authenticated network HTML');
    assert.equal(online.entries.size, 0);
    assert.equal(online.requests[0].init.cache, 'no-store');
    const failure = await workerHarness(dir, { status: 500 });
    assert.equal((await failure.fetch('/accounts')).status, 500);
    const offline = await workerHarness(dir, { offline: true });
    offline.entries.set('/offline.html', new Response('Public disconnected page'));
    assert.equal(await (await offline.fetch('/accounts')).text(), 'Public disconnected page');
    assert.deepEqual([...offline.entries.keys()], ['/offline.html']);
    offline.entries.clear();
    assert.equal((await offline.fetch('/accounts')).status, 503);
  });
});

test('real Vite production build emits installable Finance metadata, PNG icons and generated worker', async () => {
  await fixture(async dir => {
    await build({ configFile: resolve('vite.config.ts'), logLevel: 'silent', build: { outDir: dir, emptyOutDir: true } });
    const exists = async name => {
      try { return await readFile(join(dir, name)); }
      catch { assert.fail(`Production build must emit ${name}`); }
    };
    const metadata = JSON.parse(await exists('version.json'));
    assert.equal(metadata.version, process.env.APP_VERSION ?? 'dev');
    assert.match(metadata.buildId, /^[a-f0-9]{64}$/);
    assert.ok((await exists('sw.js')).toString().includes(metadata.buildId));
    const manifest = JSON.parse(await exists('manifest.webmanifest'));
    assert.equal(manifest.name, 'Finance');
    assert.equal(manifest.display, 'standalone');
    assert.equal(manifest.start_url, '/');
    assert.equal(manifest.scope, '/');
    for (const size of [192, 512]) {
      const icon = manifest.icons.find(icon => icon.sizes === `${size}x${size}`);
      assert.equal(icon.type, 'image/png');
      const bytes = await exists(icon.src.replace(/^\//, ''));
      assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
      assert.equal(bytes.readUInt32BE(16), size);
      assert.equal(bytes.readUInt32BE(20), size);
    }
    const html = (await exists('index.html')).toString();
    assert.match(html, /rel="manifest"[^>]+href="\/manifest.webmanifest"/);
    assert.match(html, /rel="apple-touch-icon"/);
    const offline = (await exists('offline.html')).toString();
    assert.match(offline, /disconnected/i);
    assert.match(offline, /<button[^>]*>.*retry.*<\/button>/i);
    assert.doesNotMatch(offline, /\/assets\/|\/api\/|<script[^>]+src=/);
    const worker = await workerHarness(dir);
    await worker.dispatch('install');
    assert.deepEqual([...worker.entries.keys()], ['/offline.html']);
  });
});

test('production static router revalidates PWA files and never returns the SPA for missing assets or APIs', async () => {
  const modulePath = new URL('../server/static-serving.ts', import.meta.url);
  try { await readFile(modulePath); } catch { assert.fail('Production static router must exist'); }
  const { registerStaticRoutes } = await import(modulePath.href);
  await fixture(async dir => {
    for (const name of ['sw.js', 'version.json', 'manifest.webmanifest']) {
      await writeFile(join(dir, name), name);
    }
    const app = new Hono();
    app.get('/api/private', c => c.json({ error: 'Unauthorized' }, 401));
    app.all('/api/*', c => c.json({ error: 'API endpoint not found.' }, 404));
    registerStaticRoutes(app, dir);
    for (const path of ['/settings', '/dashboard', '/transactions', '/accounts/demo-checking']) {
      const response = await app.request(path, { headers: { Accept: 'text/html', 'Sec-Fetch-Dest': 'empty' } });
      assert.equal(response.status, 200, `service-worker navigation ${path}`);
      assert.match(await response.text(), /<html>Finance/);
    }
    for (const destination of ['script', 'style', 'image']) {
      assert.equal((await app.request('/settings', { headers: { Accept: 'text/html', 'Sec-Fetch-Dest': destination } })).status, 404);
    }
    for (const path of ['/api/missing', '/assets/missing', '/missing.js']) {
      const response = await app.request(path, { headers: { Accept: 'text/html', 'Sec-Fetch-Dest': 'empty' } });
      assert.equal(response.status, 404, `service-worker missing resource ${path}`);
      assert.doesNotMatch(await response.text(), /<html>Finance/);
    }
    assert.equal((await app.request('/settings', { headers: { Accept: 'application/json', 'Sec-Fetch-Dest': 'empty' } })).status, 404);
    for (const method of ['GET', 'HEAD']) {
      for (const path of ['/', '/settings', '/index.html', '/sw.js', '/version.json', '/manifest.webmanifest', '/offline.html']) {
        const response = await app.request(path, { method });
        assert.equal(response.status, 200, `${method} ${path}`);
        assert.match(response.headers.get('Cache-Control'), /no-cache|no-store/, path);
        if (method === 'HEAD') assert.equal(await response.text(), '');
        else await response.text();
      }
    }
    const worker = await app.request('/sw.js');
    assert.match(worker.headers.get('Content-Type'), /javascript/);
    assert.equal(worker.headers.get('Service-Worker-Allowed'), '/');
    await worker.text();
    const manifest = await app.request('/manifest.webmanifest');
    assert.match(manifest.headers.get('Content-Type'), /manifest\+json/);
    await manifest.text();
    for (const path of ['/assets/missing.js', '/assets/missing', '/icons/missing.png', '/missing.css', '/missing.html', '/api', '/api/missing']) {
      const response = await app.request(path);
      assert.equal(response.status, 404, path);
      assert.doesNotMatch(await response.text(), /<html>Finance/);
    }
    assert.equal((await app.request('/api/private')).status, 401);
    assert.equal((await app.request('/%61pi/private')).status, 401); // Hono decodes before matching the API route.
    assert.equal((await app.request('/settings', { method: 'POST' })).status, 404);
    assert.equal((await app.request('/settings', { headers: { Accept: 'application/json' } })).status, 404);
  });
});
