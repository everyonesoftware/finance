import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Hono } from 'hono';

test('the existing server supports native username login, scoped ledger reads, and session revocation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'finance-native-session-'));
  const origin = 'https://finance.example.test';
  process.env.DATABASE_PATH = join(dir, 'finance.sqlite');
  process.env.ORIGIN_URL = origin;
  process.env.BETTER_AUTH_SECRET = randomBytes(32).toString('hex');
  const database = await import('../server/database.ts');
  try {
    await database.runMigrations();
    const { auth } = await import('../server/auth.ts');
    const { bankAccountsRouter } = await import('../server/bank_accounts.ts');
    const app = new Hono();
    app.all('/api/auth/*', context => auth.handler(context.req.raw));
    app.route('/api/accounts', bankAccountsRouter);
    const request = (path, { body, cookie } = {}) => app.request(`${origin}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json', origin }), ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const password = randomBytes(24).toString('base64url');
    async function register(username) {
      const response = await request('/api/auth/sign-up/email', {
        body: { email: `${username}@example.test`, name: username, username, password },
      });
      assert.equal(response.status, 200, response.ok ? undefined : (await response.json()).code);
    }
    async function login(username) {
      const response = await request('/api/auth/sign-in/username', { body: { username, password } });
      assert.equal(response.status, 200);
      const headers = response.headers.getSetCookie();
      assert.ok(headers.some(header => /(?:^|;)\s*Secure(?:;|$)/i.test(header)));
      assert.ok(headers.some(header => /(?:^|;)\s*HttpOnly(?:;|$)/i.test(header)));
      return headers.map(header => header.split(';', 1)[0]).join('; ');
    }
    await register('financeowner');
    await register('financeother');
    assert.equal((await request('/api/accounts')).status, 401);
    assert.equal((await request('/api/auth/sign-in/username', {
      body: { username: 'financeowner', password: `${password}-wrong` },
    })).status, 401);
    const ownerCookie = await login('financeowner');
    const otherCookie = await login('financeother');
    const session = await request('/api/auth/get-session', { cookie: ownerCookie });
    assert.equal(session.status, 200);
    assert.equal((await session.json()).user.username, 'financeowner');
    const created = await request('/api/accounts', { cookie: ownerCookie, body: {
      name: 'Native integration account', institutionName: 'Fixture Bank', type: 'depository',
      subtype: 'checking', currencyCode: 'USD', currentBalance: 174.39,
    } });
    assert.equal(created.status, 201);
    const { account } = await created.json();
    const read = await request(`/api/accounts/${account.id}/transactions`, { cookie: ownerCookie });
    assert.equal(read.status, 200);
    assert.equal((await read.json()).account.currentBalance, 174.39);
    assert.equal((await request(`/api/accounts/${account.id}/transactions`, { cookie: otherCookie })).status, 404);
    const listing = await request('/api/accounts', { cookie: otherCookie });
    assert.deepEqual((await listing.json()).accounts, []);
    assert.equal((await request('/api/auth/sign-out', { cookie: ownerCookie, body: {} })).status, 200);
    assert.equal((await request('/api/accounts', { cookie: ownerCookie })).status, 401);
  } finally {
    await database.closeDatabase();
    await rm(dir, { recursive: true, force: true });
  }
});
