import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

test('production account writes honor the configured HTTPS origin behind an HTTP proxy', async () => {
  const directory = await mkdtemp(join(process.env.TMPDIR || tmpdir(), 'manual-origin-'));
  try {
    const script = `
      import assert from 'node:assert/strict';
      import { Hono } from 'hono';
      import { runMigrations, sqliteClient as db, closeDatabase } from './server/database.ts';
      import { auth } from './server/auth.ts';
      import { bankAccountsRouter } from './server/bank_accounts.ts';
      await runMigrations();
      db.prepare('INSERT INTO user(id,name,email) VALUES(?,?,?)').run('owner','Owner','origin@example.test');
      auth.api.getSession = async () => ({ user: { id: 'owner' } });
      const app = new Hono().route('/api/accounts', bankAccountsRouter);
      const post = (path, body, origin = 'https://finance.example.test') => app.request('http://internal:3000/api/accounts' + path, {
        method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(body),
      });
      const response = await post('', { name: 'Cash', institutionName: 'Personal', type: 'depository', subtype: 'other', currencyCode: 'USD' });
      assert.equal(response.status, 201);
      const { account } = await response.json();
      assert.equal(account.mask, null);
      const file = { fileName: 'x.csv', content: 'Date,Description,Amount\\n2026-11-01,Proxy import,-1' };
      assert.equal((await post('/' + account.id + '/import/preview', file)).status, 200);
      assert.equal((await post('/' + account.id + '/import', file)).status, 200);
      assert.equal((await post('', {}, 'https://attacker.example.test')).status, 403);
      assert.equal(db.prepare('SELECT count(*) n FROM bank_transaction').get().n, 1);
      await closeDatabase();
    `;
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
      cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 60_000,
      env: { ...process.env, DATABASE_PATH: join(directory, 'fixture.sqlite'), BETTER_AUTH_SECRET: 'isolated-origin-test-secret-at-least-32-characters', ORIGIN_URL: 'https://finance.example.test' },
    });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
