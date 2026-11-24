import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync, closeSync, copyFileSync, lstatSync, mkdtempSync, mkdirSync,
  openSync, readFileSync, readdirSync, readSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// The caller supplies verified build artifacts from the exact checkout and serializes `publish`.
// `select`: GITHUB_RUN_NUMBER, optional RELEASE_FORCE_{ANDROID,WINDOWS} and RELEASE_VALIDATE_ONLY.
// `publish`: RELEASE_VERSION, RELEASE_ANDROID, RELEASE_WINDOWS; stages under dist/native/.
// Both commands use GITHUB_SHA, GITHUB_REPOSITORY and gh's normal authentication.
const platforms = ['android', 'windows'];
const versionPattern = /^0\.1\.([1-9][0-9]*)$/;
const sha256Pattern = /^[a-f0-9]{64}$/;
const shaPattern = /^[a-f0-9]{40}$/;
const marker = /^<!-- finance-native-release: (android windows|android|windows) -->$/;

function requireThat(condition, message) {
  if (!condition) throw new Error(message);
}

function versionNumber(version) {
  const number = versionPattern.exec(version)?.[1];
  requireThat(number && Number.isSafeInteger(Number(number)), 'Expected native version 0.1.<positive run number>');
  return Number(number);
}

function flag(value, name) {
  requireThat(value === true || value === false || value === 'true' || value === 'false', `${name} must be true or false`);
  return value === true || value === 'true';
}

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trimEnd();
}

function ancestry(cwd, ancestor, descendant) {
  const result = spawnSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], { cwd, encoding: 'utf8' });
  if (result.status === 0 || result.status === 1) return result.status === 0;
  throw new Error(`Git ancestry check failed: ${result.error ?? result.stderr}`);
}

function validateSource(cwd, sourceSha) {
  requireThat(shaPattern.test(sourceSha) && git(cwd, 'rev-parse', 'HEAD') === sourceSha, 'GITHUB_SHA must match the exact checked-out HEAD');
  requireThat(git(cwd, 'rev-parse', '--is-shallow-repository') === 'false', 'Native release requires full Git history');
}

function affected(path, platform) {
  if (/^(README\.md$|docs\/|tests\/|\.github\/workflows\/services-connection-test\.yml$|scripts\/(native-release[\w-]*\.mjs|benchmark-transactions\.mjs|publish-notification\.mjs|publisher-connection-test\.mjs)$)/.test(path)) return false;
  if (path.startsWith('android/') || path === 'scripts/build-finance-android.sh') return platform === 'android';
  if (path.startsWith('apps/windows/') || path === 'scripts/build-finance-windows.ps1') return platform === 'windows';
  if (path === 'public/icons/finance-192.png') return platform === 'windows';
  // The native clients compile independently of the hosted web/server client.
  if (/^(src\/|public\/|server\/|(?:package(?:-lock)?\.json|vite\.config\.ts|tsconfig(?:\.server)?\.json|index\.html|Dockerfile|docker-compose\.yml|\.dockerignore|\.env\.example)$)/.test(path)) return false;
  return true; // Shared workflow and unknown inputs are conservative.
}

function withScratch(action) {
  const dir = mkdtempSync(join(tmpdir(), 'finance-native-'));
  try { return action(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

function stagedNames(platform, version) {
  if (platform === 'android') return [`Finance-android-${version}.apk`];
  return [`Finance-windows-x64-${version}-Setup.exe`, 'releases.win-x64.json', `EveryoneSoftware.Finance-${version}-win-x64-full.nupkg`];
}

function manifestName(platform) { return `${platform}.json`; }
function checksumLine(name, sha256) { return `${sha256}  ${name}\n`; }

function describeFile(path, name) {
  const stat = lstatSync(path);
  requireThat(stat.isFile() && stat.size > 0, `Expected a nonempty regular file: ${name}`);
  const fd = openSync(path, 'r');
  const hash = createHash('sha256');
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let count;
    while ((count = readSync(fd, buffer)) !== 0) hash.update(buffer.subarray(0, count));
  } finally { closeSync(fd); }
  return { name, size: stat.size, sha256: hash.digest('hex') };
}

function snapshotPlatform(cwd, scratch, platform, version, sourceSha) {
  const from = resolve(cwd, 'dist', 'native', platform);
  const to = join(scratch, 'upload', platform);
  const names = stagedNames(platform, version);
  const actual = readdirSync(from).sort();
  requireThat(JSON.stringify(actual) === JSON.stringify([...names].sort()), `Unexpected ${platform} stage inventory: ${actual.join(', ')}`);
  mkdirSync(to, { recursive: true });
  for (const name of names) {
    requireThat(lstatSync(join(from, name)).isFile(), `Expected a regular staged file: ${name}`);
    copyFileSync(join(from, name), join(to, name));
  }
  const main = describeFile(join(to, names[0]), names[0]);
  const checksum = `${main.name}.sha256`;
  writeFileSync(join(to, checksum), checksumLine(main.name, main.sha256));
  const manifest = manifestName(platform);
  const assets = [...names, checksum].map((name) => describeFile(join(to, name), name));
  writeFileSync(join(to, manifest), `${JSON.stringify({ schemaVersion: 1, platform, version, sourceSha, assets }, null, 2)}\n`);
  return [...assets, describeFile(join(to, manifest), manifest)].map((asset) => ({ ...asset, path: join(to, asset.name) }));
}

function inventory(assets) {
  requireThat(Array.isArray(assets), 'Missing release asset inventory');
  const byName = new Map(), byId = new Set();
  for (const asset of assets) {
    const key = asset.name?.toLowerCase();
    requireThat(key && !byName.has(key) && !byId.has(asset.id) && Number.isSafeInteger(asset.id) && asset.id > 0, 'Invalid or duplicate release asset');
    byName.set(key, asset);
    byId.add(asset.id);
  }
  return byName;
}

function verifyAsset(asset, expected) {
  requireThat(asset?.name === expected.name && asset.state === 'uploaded' && asset.size === expected.size, `Missing or conflicting release asset: ${expected.name}`);
  if (asset.digest != null) {
    requireThat(asset.digest === `sha256:${expected.sha256}`, `Asset digest mismatch: ${expected.name}`);
  }
}

function download(github, scratch, asset) {
  requireThat(asset?.state === 'uploaded' && Number.isSafeInteger(asset.size) && asset.size > 0, 'Missing or incomplete release asset');
  const dst = join(scratch, `download-${asset.id}`);
  github.download(asset.id, dst);
  const file = describeFile(dst, asset.name);
  verifyAsset(asset, file);
  return { dst, ...file };
}

function publishedPlatforms(release) {
  const match = release.body?.split('\n').map((line) => marker.exec(line)).find(Boolean);
  const names = inventory(release.assets);
  if (match) return match[1].split(' ');
  const found = platforms.filter((p) => names.has(manifestName(p)));
  requireThat(found.length, `No native manifests in ${release.tag_name}`);
  return found;
}

function verifyBaseline(github, scratch, release, platform, sourceSha, version) {
  const assets = inventory(release.assets);
  const name = manifestName(platform);
  const asset = assets.get(name);
  requireThat(asset?.name === name && asset.size <= 64 * 1024, `Missing or invalid manifest: ${name}`);
  const manifest = JSON.parse(readFileSync(download(github, scratch, asset).dst, 'utf8'));
  requireThat(manifest.schemaVersion === 1 && manifest.platform === platform && manifest.version === version && manifest.sourceSha === sourceSha, `Manifest identity mismatch: ${release.tag_name}/${name}`);
  const names = stagedNames(platform, version);
  const checksum = `${names[0]}.sha256`;
  const expected = [...names, checksum];
  requireThat(Array.isArray(manifest.assets) && manifest.assets.length === expected.length && expected.every((n) => manifest.assets.filter((a) => a?.name === n).length === 1), `Invalid manifest inventory: ${name}`);
  for (const item of manifest.assets) {
    requireThat(sha256Pattern.test(item.sha256) && Number.isSafeInteger(item.size) && item.size > 0, `Invalid manifest digest or size: ${item.name}`);
    const remote = assets.get(item.name.toLowerCase());
    verifyAsset(remote, item);
    if (item.name === checksum || remote.digest == null) {
      const file = download(github, scratch, remote);
      requireThat(file.sha256 === item.sha256, `Asset byte mismatch: ${item.name}`);
      if (item.name === checksum) {
        const primary = manifest.assets.find((a) => a.name === names[0]);
        requireThat(item.size <= 512 && readFileSync(file.dst, 'utf8') === checksumLine(primary.name, primary.sha256), `Invalid checksum sidecar: ${item.name}`);
      }
    }
  }
}

function releaseState({ cwd, github, sourceSha, version }, scratch) {
  const number = versionNumber(version);
  const tag = `native-v${version}`;
  const baselines = new Map();
  let stale = false;
  const releases = github.list().filter((release) => release.tag_name?.startsWith('native-v'));
  const ranked = releases.map((release) => ({ release, rank: versionNumber(release.tag_name.slice(8)) }));
  requireThat(new Set(ranked.map(({ rank }) => rank)).size === ranked.length, 'Duplicate native releases');
  const exact = releases.find((release) => release.tag_name === tag) ?? github.findExact(tag);
  for (const { release, rank } of ranked.sort((a, b) => b.rank - a.rank)) {
    if (release.draft || release.prerelease) continue;
    const available = publishedPlatforms(release).filter((platform) => !baselines.has(platform));
    if (!available.length) continue;
    const sha = github.tag(release.tag_name);
    requireThat(shaPattern.test(sha), `Cannot resolve native tag ${release.tag_name}`);
    for (const platform of available) {
      verifyBaseline(github, scratch, release, platform, sha, release.tag_name.slice(8));
      baselines.set(platform, sha);
    }
    const ahead = sha !== sourceSha && ancestry(cwd, sourceSha, sha);
    requireThat(ahead || ancestry(cwd, sha, sourceSha), `Native release ${release.tag_name} has divergent source history`);
    if (rank > number || ahead) stale = true;
  }
  return { baselines, stale, exact, tag };
}

function title(version) { return `Finance ${version}`; }
function draftBody(selected) { return `<!-- finance-native-release: ${selected.join(' ')} -->`; }

function verifyTarget(github, release, tag, sourceSha, version, selected) {
  requireThat(release?.tag_name === tag && release.name === title(version) && release.target_commitish === sourceSha && !release.prerelease, `Conflicting release identity at ${tag}`);
  requireThat(github.tag(tag) === sourceSha, `Tag ${tag} does not resolve to checked-out source`);
  if (release.draft) requireThat(release.body === draftBody(selected), 'Conflicting draft platform selection');
}

export function selectNativeRelease(options) {
  const { cwd, sourceSha, version, github, forceAndroid = false, forceWindows = false, validateOnly = false } = options;
  const forced = { android: flag(forceAndroid, 'RELEASE_FORCE_ANDROID'), windows: flag(forceWindows, 'RELEASE_FORCE_WINDOWS') };
  const validation = flag(validateOnly, 'RELEASE_VALIDATE_ONLY');
  validateSource(cwd, sourceSha);
  return withScratch((scratch) => {
    const { baselines, stale, exact, tag } = releaseState(options, scratch);
    let selected = [];
    if (!stale && exact) {
      if (exact.draft) {
        selected = marker.exec(exact.body)?.[1].split(' ') ?? [];
        requireThat(selected.length, 'Missing draft platform selection');
      }
      verifyTarget(github, exact, tag, sourceSha, version, selected);
    } else if (!stale) {
      selected = platforms.filter((platform) => {
        const baseline = baselines.get(platform);
        if (!baseline || forced[platform]) return true;
        return git(cwd, 'diff', '--name-only', '-z', '--no-renames', baseline, sourceSha, '--').split('\0').some((path) => path && affected(path, platform));
      });
    }
    return { version, android: selected.includes('android'), windows: selected.includes('windows'), publish: !validation && selected.length > 0 };
  });
}

export function publishNativeRelease(options) {
  const { cwd, sourceSha, version, github } = options;
  const selected = platforms.filter((p) => flag(options[p], `RELEASE_${p.toUpperCase()}`));
  requireThat(selected.length, 'No native platforms selected');
  validateSource(cwd, sourceSha);
  return withScratch((scratch) => {
    // The caller serializes publishers. Re-read baselines under that lock so an old run cannot move Latest backwards.
    const { exact, tag, stale } = releaseState(options, scratch);
    if (stale && (!exact || exact.draft)) return { tag, status: 'superseded' };
    const files = selected.flatMap((platform) => snapshotPlatform(cwd, scratch, platform, version, sourceSha));
    const names = new Set(files.map((file) => file.name.toLowerCase()));
    requireThat(names.size === files.length, 'Local release asset collision');
    let release = exact && github.get(exact.id);
    const originalTag = github.tag(tag);
    requireThat(originalTag === null || originalTag === sourceSha, `Conflicting source for ${tag}`);
    if (release) {
      requireThat(release.tag_name === tag && release.target_commitish === sourceSha && release.name === title(version) && !release.prerelease, `Conflicting release identity at ${tag}`);
      if (release.draft) requireThat(release.body === draftBody(selected), 'Conflicting draft platform selection');
      else requireThat(originalTag === sourceSha, `Missing tag for published release ${tag}`);
    }
    const preflight = inventory(release?.assets ?? []);
    const missing = [];
    // Check every name and existing byte before creating a tag or uploading anything.
    for (const name of preflight.keys()) requireThat(names.has(name), `Unexpected existing release asset: ${name}`);
    for (const file of files) {
      const asset = preflight.get(file.name.toLowerCase());
      if (!asset) { missing.push(file); continue; }
      verifyAsset(asset, file);
      requireThat(download(github, scratch, asset).sha256 === file.sha256, `Conflicting release bytes: ${file.name}`);
    }
    if (release && !release.draft) {
      requireThat(!missing.length, `Published release ${tag} is incomplete`);
      return { tag, status: 'already-published' };
    }
    if (originalTag === null) github.createTag(tag, sourceSha);
    requireThat(github.tag(tag) === sourceSha, `Tag readback mismatch: ${tag}`);
    if (!release) {
      const created = github.createDraft({ tag_name: tag, target_commitish: sourceSha, name: title(version), body: draftBody(selected), draft: true, prerelease: false, make_latest: 'false' });
      requireThat(Number.isSafeInteger(created?.id) && created.id > 0, 'Missing newly created draft ID');
      release = github.get(created.id);
      requireThat(release?.draft && inventory(release.assets).size === 0, `Expected an empty draft at ${tag}`);
    }
    verifyTarget(github, release, tag, sourceSha, version, selected);
    const id = release.id;
    for (const file of missing) github.upload(id, tag, file.path, file.name);
    const complete = github.get(id);
    verifyTarget(github, complete, tag, sourceSha, version, selected);
    requireThat(complete.draft, `Release ${tag} was published before verification`);
    const uploaded = inventory(complete.assets);
    requireThat(uploaded.size === files.length, 'Unexpected uploaded release inventory');
    for (const file of files) {
      const key = file.name.toLowerCase();
      const asset = uploaded.get(key);
      verifyAsset(asset, file);
      if (preflight.has(key)) requireThat(asset.id === preflight.get(key).id, `Asset was replaced: ${file.name}`);
      requireThat(download(github, scratch, asset).sha256 === file.sha256, `Uploaded bytes differ: ${file.name}`);
    }
    github.promote(id);
    const final = github.get(id);
    verifyTarget(github, final, tag, sourceSha, version, selected);
    const finalAssets = inventory(final.assets);
    requireThat(final.draft === false && finalAssets.size === uploaded.size && github.latest().id === id, `Published release readback failed: ${tag}`);
    for (const file of files) {
      const key = file.name.toLowerCase();
      const asset = finalAssets.get(key);
      verifyAsset(asset, file);
      requireThat(asset.id === uploaded.get(key).id, `Published asset was replaced: ${file.name}`);
    }
    return { tag, status: 'published' };
  });
}

function githubCli(repository, cwd) {
  requireThat(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repository), 'Expected GITHUB_REPOSITORY as owner/repo');
  const repo = `repos/${repository}`;
  const run = (args, { data, fd, allow404 = false } = {}) => {
    const result = spawnSync('gh', args, {
      cwd, input: data === undefined ? undefined : JSON.stringify(data), encoding: 'utf8',
      stdio: ['pipe', fd ?? 'pipe', 'pipe'], timeout: 5 * 60_000, maxBuffer: 16 * 1024 * 1024,
    });
    if (result.status === 0) return result.stdout;
    if (allow404 && result.status === 1 && /\bHTTP 404\b/.test(result.stderr)) return null;
    throw new Error(`gh ${args[0]} failed: ${result.error ?? result.stderr?.trim()}`);
  };
  const api = (path, { data, method = 'GET', paginate = false, allow404 = false } = {}) => {
    const text = run(['api', `${repo}/${path}`, '--method', method, ...(data === undefined ? [] : ['--input', '-']), ...(paginate ? ['--paginate', '--slurp'] : [])], { data, allow404 });
    if (text === null) return null;
    const value = JSON.parse(text);
    if (!paginate) return value;
    requireThat(Array.isArray(value) && value.every(Array.isArray), `Invalid paginated response: ${path}`);
    return value.flat();
  };
  return {
    list: () => api('releases?per_page=100', { paginate: true }),
    findExact(tag) {
      const [owner, name] = repository.split('/');
      // The REST list/tag endpoints need not expose drafts by pending tag name.
      const query = 'query($owner:String!,$name:String!,$tag:String!){ repository(owner:$owner,name:$name){ release(tagName:$tag){ databaseId } } }';
      const result = JSON.parse(run(['api', 'graphql', '--input', '-'], { data: { query, variables: { owner, name, tag } } }));
      const found = result.data?.repository?.release;
      requireThat(!result.errors?.length && (found === null || (Number.isSafeInteger(found?.databaseId) && found.databaseId > 0)), 'Invalid exact release lookup');
      return found === null ? null : this.get(found.databaseId);
    },
    get(id) {
      const release = api(`releases/${id}`);
      requireThat(release.id === id, 'Release ID readback mismatch');
      return { ...release, assets: api(`releases/${id}/assets?per_page=100`, { paginate: true }) };
    },
    tag(tag) {
      const ref = api(`git/ref/tags/${tag}`, { allow404: true });
      if (ref === null) return null;
      requireThat(ref.ref === `refs/tags/${tag}`, `Tag ref mismatch: ${tag}`);
      let object = ref.object;
      for (let level = 0; level < 8 && object?.type === 'tag' && shaPattern.test(object.sha); level++) {
        const annotated = api(`git/tags/${object.sha}`);
        requireThat(annotated.sha === object.sha, `Annotated tag mismatch: ${tag}`);
        object = annotated.object;
      }
      requireThat(object?.type === 'commit' && shaPattern.test(object.sha), `Cannot resolve tag ${tag} to a commit`);
      return object.sha;
    },
    createTag: (tag, sha) => api('git/refs', { method: 'POST', data: { ref: `refs/tags/${tag}`, sha } }),
    createDraft: (data) => api('releases', { method: 'POST', data }),
    upload: (_id, tag, path) => run(['release', 'upload', tag, path, '--repo', repository]),
    download(id, path) {
      const fd = openSync(path, 'w');
      try { run(['api', `${repo}/releases/assets/${id}`, '-H', 'Accept: application/octet-stream'], { fd }); } finally { closeSync(fd); }
    },
    promote: (id) => api(`releases/${id}`, { method: 'PATCH', data: { draft: false, prerelease: false, make_latest: 'true' } }),
    latest: () => api('releases/latest'),
  };
}

function main([command, ...args], env) {
  requireThat((command === 'select' || command === 'publish') && !args.length, 'Usage: node scripts/native-release.mjs select|publish');
  const cwd = process.cwd();
  const version = command === 'select' ? `0.1.${env.GITHUB_RUN_NUMBER ?? ''}` : env.RELEASE_VERSION;
  versionNumber(version);
  const options = { cwd, sourceSha: env.GITHUB_SHA, version, github: githubCli(env.GITHUB_REPOSITORY, cwd) };
  if (command === 'select') {
    const plan = selectNativeRelease({ ...options, forceAndroid: env.RELEASE_FORCE_ANDROID, forceWindows: env.RELEASE_FORCE_WINDOWS, validateOnly: env.RELEASE_VALIDATE_ONLY });
    const lines = Object.entries(plan).map(([key, value]) => `${key}=${value}`).join('\n') + '\n';
    if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, lines);
    process.stdout.write(lines);
  } else {
    requireThat(!flag(env.RELEASE_VALIDATE_ONLY ?? false, 'RELEASE_VALIDATE_ONLY'), 'Validation runs cannot publish');
    const result = publishNativeRelease({ ...options, android: env.RELEASE_ANDROID, windows: env.RELEASE_WINDOWS });
    console.log(`${result.tag}: ${result.status}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(process.argv.slice(2), process.env); } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
