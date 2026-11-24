import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const script = join(root, 'scripts/build-finance-android.sh');
const sha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();

const cases = [
  ['refuses to infer a signing mode', { RELEASE_SIGNING_ENABLED: '' }, /RELEASE_SIGNING_ENABLED must be true or false/],
  ['rejects a noncanonical version', { RELEASE_VERSION: '0.1.001' }, /RELEASE_VERSION must be/],
  ['rejects a version code above the Android bound', { RELEASE_VERSION: '0.1.2100000001' }, /versionCode out of range/],
  ['rejects a malformed source SHA', { GITHUB_SHA: 'HEAD' }, /GITHUB_SHA must be/],
  ['rejects a checkout mismatch', { GITHUB_SHA: '0'.repeat(40) }, /GITHUB_SHA does not match HEAD/],
  ['does not fall back to debug signing when signing is enabled', {}, /Missing RELEASE_KEYSTORE_BASE64/],
];

for (const [name, overrides, message] of cases) {
  test(name, () => {
    const out = mkdtempSync(join(tmpdir(), 'finance-android-preflight-'));
    try {
      const result = spawnSync('bash', [script], {
        // Run from outside the checkout, as a hosted caller may supply an absolute output directory.
        cwd: out,
        encoding: 'utf8',
        env: {
          ...process.env,
          RELEASE_VERSION: '0.1.1',
          RELEASE_ARTIFACT_DIR: out,
          RELEASE_SIGNING_ENABLED: 'true',
          GITHUB_SHA: sha,
          RELEASE_KEYSTORE_BASE64: '',
          RELEASE_KEYSTORE_PASSWORD: '',
          RELEASE_KEY_ALIAS: '',
          RELEASE_KEY_PASSWORD: '',
          ...overrides,
        },
      });
      assert.ifError(result.error);
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, message);
      assert.deepEqual(readdirSync(out), []);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
}
