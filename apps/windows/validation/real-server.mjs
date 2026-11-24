import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const dir = await mkdtemp(join(tmpdir(), 'finance-winui-'));
const reserve = createServer().listen(0, '127.0.0.1');
await once(reserve, 'listening');
const port = reserve.address().port;
await new Promise(resolve => reserve.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const password = randomBytes(24).toString('hex');
const server = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
  cwd: root, stdio: 'inherit', env: { ...process.env, PORT: String(port), ORIGIN_URL: origin,
    DATABASE_PATH: join(dir, 'fixture.sqlite'), BETTER_AUTH_SECRET: randomBytes(32).toString('hex') },
});
const stopped = once(server, 'close');
try {
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt++) {
    if (server.exitCode !== null) break;
    if (await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(500) }).then(res => res.ok, () => false)) {
      ready = true;
      break;
    }
    await delay(125);
  }
  assert.ok(ready, 'disposable Finance server did not start');
  async function post(path, body, cookie) {
    const response = await fetch(`${origin}${path}`, { method: 'POST', redirect: 'error',
      headers: { origin, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
    assert.ok(response.ok, `${path} returned HTTP ${response.status}`);
    return response;
  }
  for (const username of ['nativeowner', 'nativeother']) {
    await post('/api/auth/sign-up/email', { email: `${username}@example.test`, name: username, username, password });
  }
  const login = await post('/api/auth/sign-in/username', { username: 'nativeowner', password });
  const cookie = login.headers.getSetCookie().map(line => line.split(';', 1)[0]).join('; ');
  await post('/api/accounts', { name: 'Imported checking', institutionName: 'Fixture bank', type: 'depository',
    subtype: 'checking', currencyCode: 'USD', currentBalance: 174.39, balanceDate: '2024-01-01' }, cookie);
  await post('/api/real-estate', { address: 'Fixture property', latitude: 0, longitude: 0, amount: 250000 }, cookie);
  const checks = spawn('dotnet', ['run', '--project', 'apps/windows/validation/ApiChecks.csproj', '--', origin], {
    cwd: root, stdio: 'inherit', env: { ...process.env, FINANCE_FIXTURE_PASSWORD: password },
  });
  const [status] = await once(checks, 'close');
  assert.equal(status, 0, 'Windows Finance API checks failed');
} finally {
  server.kill();
  await stopped;
  await rm(dir, { recursive: true, force: true });
}
