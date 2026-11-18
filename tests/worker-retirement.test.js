import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

test('retirement worker activates immediately, clears only Finance caches and unregisters without intercepting requests', async () => {
  const handlers = new Map();
  const deleted = [];
  let skipped = 0, unregistered = 0;
  runInNewContext(await readFile(new URL('../public/sw.js', import.meta.url), 'utf8'), {
    self: {
      addEventListener: (type, handler) => handlers.set(type, handler),
      skipWaiting: async () => { skipped++; },
      registration: { unregister: async () => { unregistered++; return true; } },
    },
    caches: {
      keys: async () => ['another-app-cache', 'finance-pwa-offline-old', 'finance-pwa-offline-new', 'finance-other'],
      delete: async name => { deleted.push(name); return true; },
    },
  });
  assert.deepEqual([...handlers.keys()].sort(), ['activate', 'install']);
  for (const type of ['install', 'activate']) {
    const pending = [];
    handlers.get(type)({ waitUntil: promise => pending.push(promise) });
    await Promise.all(pending);
  }
  assert.equal(skipped, 1);
  assert.deepEqual(deleted, ['finance-pwa-offline-old', 'finance-pwa-offline-new']);
  assert.equal(unregistered, 1);
});
