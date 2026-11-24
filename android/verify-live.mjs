// Run after assembleDebug and assembleDebugAndroidTest, against a disposable emulator.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getRequestListener } from '@hono/node-server';
import { Hono } from 'hono';

const serial = process.env.ANDROID_SERIAL;
const avd = process.env.FINANCE_TEST_AVD;
assert.match(serial ?? '', /^emulator-\d+$/);
assert.ok(avd, 'Set FINANCE_TEST_AVD to your disposable emulator’s AVD name');
function adb(...args) {
  return new Promise((resolve, reject) => {
    const command = spawn('adb', ['-s', serial, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    const output = [];
    command.stdout.on('data', data => output.push(data));
    command.stderr.on('data', data => output.push(data));
    command.on('error', reject);
    command.on('close', code => code === 0 ? resolve(Buffer.concat(output).toString()) : reject(new Error(`adb ${args[0]} failed (${code})`)));
  });
}
assert.equal((await adb('emu', 'avd', 'name')).split(/\r?\n/)[0], avd);
assert.equal((await adb('shell', 'getprop', 'sys.boot_completed')).trim(), '1');
const dir = await mkdtemp(join(tmpdir(), 'finance-android-'));
let database, reversed;
const observed = [];
const app = new Hono();
app.use('*', async (ctx, next) => {
  await next();
  observed.push({ path: ctx.req.path, method: ctx.req.method, status: ctx.res.status });
});
const server = createServer(getRequestListener(app.fetch));
try {
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  process.env.DATABASE_PATH = join(dir, 'finance.sqlite');
  process.env.BETTER_AUTH_SECRET = randomBytes(32).toString('hex');
  process.env.ORIGIN_URL = origin;
  database = await import('../server/database.ts');
  await database.runMigrations();
  const { auth } = await import('../server/auth.ts');
  const { bankAccountsRouter } = await import('../server/bank_accounts.ts');
  const { realEstateRouter } = await import('../server/real_estate.ts');
  app.all('/api/auth/*', ctx => auth.handler(ctx.req.raw));
  app.route('/api/accounts', bankAccountsRouter);
  app.route('/api/real-estate', realEstateRouter);
  const password = randomBytes(22).toString('hex');
  async function json(path, { body, cookie, status = 200 } = {}) {
    const response = await fetch(`${origin}${path}`, {
      method: body === undefined ? 'GET' : 'POST', redirect: 'error',
      headers: { ...(body === undefined ? {} : { origin, 'content-type': 'application/json' }), ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await response.json();
    assert.equal(response.status, status, `${path} (${data?.code ?? 'no error code'})`);
    return { data, cookie: response.headers.getSetCookie()
      .find(value => value.startsWith('better-auth.session_token='))?.split(';', 1)[0] };
  }
  const registration = await json('/api/auth/sign-up/email', {
    body: { name: 'Android fixture', username: 'native_owner', email: 'native-owner@example.test', password },
  });
  const cookie = registration.cookie;
  assert.ok(cookie);
  const { data: { account } } = await json('/api/accounts', { cookie, status: 201, body: {
    name: 'Native checking', institutionName: 'Fixture Bank', type: 'depository', subtype: 'checking',
    currencyCode: 'USD', currentBalance: 174.39, balanceDate: '2024-02-01',
  } });
  const importPath = `/api/accounts/${account.id}/import`;
  const seed = { fileName: 'fixture.csv', content: 'Date,Description,Amount\n2024-01-02,Fixture groceries,-16.49\n' };
  const { data: review } = await json(`${importPath}/preview`, { cookie, body: seed });
  assert.equal(review.importable, 1);
  assert.equal((await json(importPath, { cookie, body: { ...seed, previewToken: review.previewToken } })).data.imported, 1);
  await json('/api/real-estate', { cookie, status: 201, body: { address: '123 Android Test Ave', latitude: 38, longitude: -77, amount: 10000 } });
  const start = observed.length;
  reversed = `tcp:${port}`;
  await adb('reverse', reversed, reversed);
  const apk = path => fileURLToPath(new URL(`./app/build/outputs/apk/${path}`, import.meta.url));
  await adb('install', '-r', apk('debug/app-debug.apk'));
  await adb('install', '-r', apk('androidTest/debug/app-debug-androidTest.apk'));
  await adb('shell', 'pm', 'clear', 'com.everyonesoftware.finance');
  const output = await adb('shell', 'am', 'instrument', '-w', '-r', '-e', 'financeOrigin', origin,
    '-e', 'financePassword', password, 'com.everyonesoftware.finance.test/androidx.test.runner.AndroidJUnitRunner');
  process.stdout.write(output.replaceAll(password, '[redacted]'));
  const native = observed.slice(start);
  assert.ok(/OK \(2 tests\)/.test(output) && !/FAILURES|INSTRUMENTATION_FAILED|INSTRUMENTATION_STATUS_CODE: -[234]/.test(output),
    `Android instrumentation failed. HTTP statuses observed: ${native.map(({ method, path, status }) => `${method} ${path} ${status}`).join(', ')}`);
  for (const [path, method, status, count] of [
    ['/api/auth/sign-in/username', 'POST', 401, 1], ['/api/auth/get-session', 'GET', 200, 2],
    ['/api/auth/sign-out', 'POST', 200, 2], ['/api/accounts/net-worth', 'GET', 200, 1],
    ['/api/accounts/transactions/all', 'GET', 200, 1], ['/api/real-estate', 'GET', 200, 1],
    [importPath, 'POST', 200, 1], [importPath, 'POST', 409, 1],
  ]) assert.equal(native.filter(entry => entry.path === path && entry.method === method && entry.status === status).length, count, `${method} ${path} ${status}`);
  const { data } = await json(`/api/accounts/${account.id}/transactions`, { cookie });
  assert.equal(data.transactions.filter(tx => tx.name === 'Imported by Android').length, 1);
  console.log('Real Finance router and independent SQLite-backed readback verified.');
} finally {
  if (reversed) await adb('reverse', '--remove', reversed).catch(() => {});
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await database?.closeDatabase();
  await rm(dir, { recursive: true, force: true });
}
