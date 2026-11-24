import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const yaml = await readFile(new URL('../.github/workflows/publish.yml', import.meta.url), 'utf8');
const job = name => yaml.match(new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z][a-z_]*:|$(?![\\s\\S]))`, 'm'))?.[1] ?? '';

test('Finance calls one SHA-pinned shared job per platform and preserves the independent image publication', () => {
  for (const platform of ['android', 'windows']) {
    assert.match(job(platform), new RegExp(`everyonesoftware/workflows-common/\\.github/workflows/build-${platform}-v1\\.yml@[a-f0-9]{40}`));
    assert.match(job(platform), /needs: \[verify, native_selection\]/);
  }
  assert.match(job('publish'), /id: services_push/);
  assert.match(job('services_notify'), /needs: publish/);
});

test('validation-only dispatch cannot publish or expose release signing credentials', () => {
  const android = job('android');
  assert.match(android, /signing-enabled: \$\{\{ github\.event_name == 'push' \|\| inputs\.publish_native \}\}/);
  for (const secret of ['KEYSTORE_BASE64', 'KEYSTORE_PASSWORD', 'KEY_ALIAS', 'KEY_PASSWORD']) {
    assert.match(android, new RegExp(`\\(github\\.event_name == 'push' \\|\\| inputs\\.publish_native\\) && secrets\\.FINANCE_${secret} \\|\\| ''`));
  }
  const publish = job('native_release');
  assert.match(publish, /needs: \[verify, native_selection, android, windows\]/);
  assert.match(publish, /github\.event_name == 'push' \|\| inputs\.publish_native/);
  assert.match(publish, /needs\.android\.result == 'success' \|\| needs\.android\.result == 'skipped'/);
  assert.match(publish, /needs\.windows\.result == 'success' \|\| needs\.windows\.result == 'skipped'/);
  assert.match(publish, /run: node scripts\/native-release\.mjs publish/);
});
