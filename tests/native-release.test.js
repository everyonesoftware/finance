import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { selectNativeRelease, publishNativeRelease } from '../scripts/native-release.mjs';

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'finance-release-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Release Test');
  git('config', 'user.email', 'test@example.com');
  git('config', 'commit.gpgsign', 'false');
  const file = (path, contents) => {
    const target = join(cwd, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents);
  };
  const commit = (path, contents) => {
    file(path, contents);
    git('add', '--', path);
    git('commit', '-qm', path);
    return git('rev-parse', 'HEAD');
  };
  const releases = [], tags = new Map(), bytes = new Map(), writes = [];
  let sequence = 0, latest;
  const byId = (id) => releases.find((release) => release.id === id);
  const github = {
    list: () => structuredClone(releases),
    findExact: (tag) => structuredClone(releases.find((release) => release.tag_name === tag) ?? null),
    get: (id) => structuredClone(byId(id)),
    tag: (tag) => tags.get(tag) ?? null,
    createTag(tag, sha) { writes.push(['tag', tag]); tags.set(tag, sha); },
    createDraft(data) {
      const release = { ...data, id: ++sequence, assets: [] };
      releases.push(release);
      writes.push(['draft', release.tag_name]);
      return structuredClone(release);
    },
    upload(id, tag, path, name) {
      assert.equal(byId(id).tag_name, tag);
      const data = readFileSync(path);
      const asset = { id: ++sequence, name, size: data.length, state: 'uploaded' };
      byId(id).assets.push(asset);
      bytes.set(asset.id, data);
      writes.push(['upload', name]);
    },
    download(id, path) { writeFileSync(path, bytes.get(id)); },
    promote(id) { byId(id).draft = false; latest = id; writes.push(['promote', id]); },
    latest: () => ({ id: latest }),
  };
  const sha = commit('README.md', 'initial');
  const opts = (sourceSha = sha, version = '0.1.1') => ({ cwd, github, sourceSha, version });
  const android = (version = '0.1.1') => file(`dist/native/android/Finance-android-${version}.apk`, 'signed apk fixture');
  const windows = (version = '0.1.1') => {
    file(`dist/native/windows/Finance-windows-x64-${version}-Setup.exe`, 'installer fixture');
    file('dist/native/windows/releases.win-x64.json', '{}');
    file(`dist/native/windows/EveryoneSoftware.Finance-${version}-win-x64-full.nupkg`, 'full package fixture');
  };
  return { cwd, sha, git, file, commit, github, opts, android, windows, releases, tags, bytes, writes };
}

function stageBoth(f) { f.android(); f.windows(); }
const both = { android: true, windows: true };
const androidOnly = { android: true, windows: false };

test('first publication selects both platforms and strict force values are required', (t) => {
  const f = fixture(t);
  assert.deepEqual(selectNativeRelease(f.opts()), { version: '0.1.1', android: true, windows: true, publish: true });
  assert.throws(() => selectNativeRelease({ ...f.opts(), forceAndroid: 'yes' }), /force.*true or false/i);
  assert.throws(() => selectNativeRelease(f.opts(f.sha, '0.1.01')), /version/i);
});

test('both platforms share a draft, get read back, and retry does not write', (t) => {
  const f = fixture(t);
  stageBoth(f);
  const options = { ...f.opts(), ...both };
  publishNativeRelease(options);
  assert.equal(f.releases.length, 1);
  assert.equal(f.releases[0].tag_name, 'native-v0.1.1');
  assert.equal(f.tags.get('native-v0.1.1'), f.sha);
  assert.equal(f.releases[0].assets.length, 8);
  assert.equal(f.releases[0].draft, false);
  assert.equal(f.writes.at(-1)[0], 'promote');
  const before = f.writes.length;
  publishNativeRelease(options);
  assert.equal(f.writes.length, before);
});

test('platform baselines are independent and include unpublished changes across pushes', (t) => {
  const f = fixture(t);
  stageBoth(f);
  publishNativeRelease({ ...f.opts(), ...both });
  f.commit('android/app/build.gradle.kts', 'new android inputs');
  const docs = f.commit('docs/readme.md', 'docs after failed build');
  assert.deepEqual(selectNativeRelease(f.opts(docs, '0.1.3')), { version: '0.1.3', ...androidOnly, publish: true });
  rmSync(join(f.cwd, 'dist/native/android'), { recursive: true });
  f.android('0.1.3');
  publishNativeRelease({ ...f.opts(docs, '0.1.3'), ...androidOnly });
  const web = f.commit('server/index.ts', 'server-only edit');
  const script = f.commit('scripts/native-release.mjs', 'control-plane edit');
  assert.deepEqual(selectNativeRelease(f.opts(script, '0.1.4')), { version: '0.1.4', android: false, windows: false, publish: false });
  assert.deepEqual(selectNativeRelease({ ...f.opts(script, '0.1.4'), forceWindows: 'true', validateOnly: 'true' }), { version: '0.1.4', android: false, windows: true, publish: false });
  const windows = f.commit('scripts/build-finance-windows.ps1', web);
  assert.deepEqual(selectNativeRelease(f.opts(windows, '0.1.5')), { version: '0.1.5', android: false, windows: true, publish: true });
  const unknown = f.commit('shared/Unknown.props', 'unknown native input');
  assert.deepEqual(selectNativeRelease(f.opts(unknown, '0.1.6')), { version: '0.1.6', ...both, publish: true });
  assert.equal(f.releases[0].assets.length, 8, 'do not touch prior bundled platform assets');
});

test('the shared Finance icon rebuilds the Windows client that packages it', (t) => {
  const f = fixture(t);
  stageBoth(f);
  publishNativeRelease({ ...f.opts(), ...both });
  const source = f.commit('public/icons/finance-192.png', 'replacement branding');
  assert.deepEqual(selectNativeRelease(f.opts(source, '0.1.2')),
    { version: '0.1.2', android: false, windows: true, publish: true });
});

test('a corrupt binary without a provider digest cannot become a baseline', (t) => {
  const f = fixture(t);
  stageBoth(f);
  publishNativeRelease({ ...f.opts(), ...both });
  const apk = f.releases[0].assets.find((x) => x.name.endsWith('.apk'));
  f.bytes.set(apk.id, Buffer.alloc(apk.size, 0x41));
  assert.throws(() => selectNativeRelease(f.opts(f.sha, '0.1.2')), /Asset byte mismatch/);
});

test('an exact-source draft recovers without overwriting the first upload', (t) => {
  const f = fixture(t);
  stageBoth(f);
  const opts = { ...f.opts(), ...both };
  const upload = f.github.upload;
  f.github.upload = (...args) => {
    if (args.at(-1).endsWith('.apk')) return upload(...args);
    throw new Error('interrupted upload');
  };
  assert.throws(() => publishNativeRelease(opts), /interrupted upload/);
  assert.equal(f.releases[0].draft, true);
  f.github.list = () => []; // Draft may not be visible in the published REST list.
  assert.deepEqual(selectNativeRelease(f.opts()), { version: '0.1.1', ...both, publish: true });
  const assetId = f.releases[0].assets[0].id;
  f.github.upload = upload;
  assert.equal(publishNativeRelease(opts).status, 'published');
  assert.equal(f.releases[0].assets[0].id, assetId);
  assert.equal(f.writes.filter(([op, name]) => op === 'upload' && name.endsWith('.apk')).length, 1);
});

test('unexpected staged files or a tag bound to another source prevent writes', (t) => {
  const f = fixture(t);
  f.android();
  f.file('dist/native/android/extra.apk', 'stowaway');
  const opts = { ...f.opts(), ...androidOnly };
  assert.throws(() => publishNativeRelease(opts), /Unexpected android stage inventory/);
  rmSync(join(f.cwd, 'dist/native/android/extra.apk'));
  f.tags.set('native-v0.1.1', 'a'.repeat(40));
  assert.throws(() => publishNativeRelease(opts), /Conflicting source/);
  assert.deepEqual(f.writes, []);
});

test('wrong bytes returned during upload verification prevent draft promotion', (t) => {
  const f = fixture(t);
  f.android();
  const upload = f.github.upload;
  f.github.upload = (...args) => {
    upload(...args);
    if (args.at(-1).endsWith('.apk')) {
      const [{ id, size }] = f.releases[0].assets;
      f.bytes.set(id, Buffer.alloc(size, 0x41));
    }
  };
  assert.throws(() => publishNativeRelease({ ...f.opts(), ...androidOnly }), /Uploaded bytes differ/);
  assert.equal(f.releases[0].draft, true);
  const before = f.writes.length;
  assert.throws(() => publishNativeRelease({ ...f.opts(), ...androidOnly }), /Conflicting release bytes/);
  assert.equal(f.writes.length, before);
});

test('a run behind a verified publication cannot create or promote a release', (t) => {
  const f = fixture(t);
  const newer = f.commit('android/new.kt', 'new source');
  stageBoth(f);
  publishNativeRelease({ ...f.opts(newer), ...both });
  f.git('checkout', '--detach', f.sha);
  const before = f.writes.length;
  const opts = f.opts(f.sha, '0.1.2');
  assert.equal(selectNativeRelease({ ...opts, forceAndroid: true }).publish, false);
  assert.deepEqual(publishNativeRelease({ ...opts, ...androidOnly }), { tag: 'native-v0.1.2', status: 'superseded' });
  assert.equal(f.writes.length, before);
});

test('selection refuses a verified release from divergent Git history', (t) => {
  const f = fixture(t);
  const released = f.commit('android/new.kt', 'released');
  f.android();
  publishNativeRelease({ ...f.opts(released), ...androidOnly });
  f.git('checkout', '-qb', 'diverged', f.sha);
  const other = f.commit('apps/windows/new.cs', 'different');
  assert.throws(() => selectNativeRelease(f.opts(other, '0.1.2')), /divergent source history/);
});

test('selector CLI writes the caller contract and validation never enables publish', (t) => {
  const f = fixture(t);
  f.file('bin/gh', `#!/bin/sh
case "$2" in
  graphql) printf '%s\\n' '{"data":{"repository":{"release":null}}}' ;;
  *) printf '%s\\n' '[[]]' ;;
esac
`);
  execFileSync('chmod', ['+x', join(f.cwd, 'bin/gh')]);
  const script = fileURLToPath(new URL('../scripts/native-release.mjs', import.meta.url));
  const output = join(f.cwd, 'outputs');
  const env = { ...process.env, PATH: `${join(f.cwd, 'bin')}${delimiter}${process.env.PATH}`,
    GITHUB_SHA: f.sha, GITHUB_REPOSITORY: 'owner/fixture', GITHUB_RUN_NUMBER: '42', GITHUB_OUTPUT: output,
    RELEASE_FORCE_ANDROID: 'false', RELEASE_FORCE_WINDOWS: 'false', RELEASE_VALIDATE_ONLY: 'true' };
  execFileSync(process.execPath, [script, 'select'], { cwd: f.cwd, env });
  assert.equal(readFileSync(output, 'utf8'), 'version=0.1.42\nandroid=true\nwindows=true\npublish=false\n');
  assert.throws(() => execFileSync(process.execPath, [script, 'publish'], { cwd: f.cwd, stdio: 'pipe', env: { ...env, RELEASE_VERSION: '0.1.42' } }), /cannot publish/);
});
