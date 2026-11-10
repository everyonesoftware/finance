import assert from 'node:assert/strict';
import test from 'node:test';

const settings = () => import('../src/teller-settings.ts');

test('Teller configuration renders blank secrets, all environments and explicit credential removal', async () => {
  const { renderTellerSettings } = await settings();
  const html = renderTellerSettings();
  for (const name of ['applicationId', 'environment', 'certificate', 'privateKey', 'signingKey']) assert.match(html, new RegExp(`name="${name}"`));
  for (const env of ['sandbox', 'development', 'production']) assert.match(html, new RegExp(`value="${env}"`));
  assert.match(html, /type="file"/);
  assert.match(html, /Leave blank to keep/);
  assert.match(html, /Clear saved credentials/);
  assert.match(html, /role="status"/);
  assert.match(html, /Sandbox needs only your application ID/);
  assert.match(html, /required for development and production/);
  const { readFile } = await import('node:fs/promises');
  const css = await readFile(new URL('../src/style.css', import.meta.url), 'utf8');
  assert.match(css, /\.teller-credential-inset\s*\{/);
  assert.match(css, /\.teller-settings-actions\s*\{[^}]*flex-wrap:\s*wrap/s);
});

test('bank linking uses server-issued Teller configuration, forwards full enrollment and nonce, and refreshes accounts', async () => {
  const { initializeBankAccountsPage } = await import('../src/bank_accounts.ts');
  const button = new Element(), container = new Element(), status = new Element();
  globalThis.document = { querySelector: s => ({ '#connect-bank': button, '#connected-accounts': container, '#accounts-message': status })[s] ?? null, querySelectorAll: () => [] };
  globalThis.location = { search: '' };
  let options, opened = false;
  globalThis.window = { TellerConnect: { setup(o) { options = o; return { open() { opened = true; } }; } } };
  const calls = [];
  globalThis.fetch = async (url, config) => { calls.push([url, config]); return response(url.endsWith('connect-config') ? { applicationId: 'app_test', environment: 'sandbox', products: ['transactions', 'balance'], nonce: 'server-nonce' } : { configured: true, accounts: [] }); };
  initializeBankAccountsPage();
  await new Promise(resolve => setTimeout(resolve, 0));
  await button.emit('click');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(opened, true);
  assert.equal(options.applicationId, 'app_test'); assert.equal(options.nonce, 'server-nonce');
  assert.deepEqual(options.products, ['transactions', 'balance']);
  const callback = { accessToken: 'token_test', user: { id: 'usr_test' }, enrollment: { id: 'enr_test', institution: { name: 'Test Bank' } }, signatures: ['signature'] };
  options.onSuccess(callback);
  await new Promise(resolve => setTimeout(resolve, 0));
  const enrollment = calls.find(([url]) => url === '/api/accounts/enroll');
  assert.deepEqual(JSON.parse(enrollment[1].body), { ...callback, nonce: 'server-nonce' });
  assert.equal(calls.filter(([url]) => url === '/api/accounts').length, 2);
  options.onExit(); assert.equal(button.disabled, false);
});

test('frontend removes the old provider and settings initializes the integration card', async () => {
  const { readFile, readdir } = await import('node:fs/promises');
  const files = await readdir(new URL('../src/', import.meta.url));
  for (const file of files) {
    const source = await readFile(new URL(`../src/${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, new RegExp('pl' + 'aid', 'i'), file);
  }
  const main = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
  assert.match(main, /\$\{renderTellerSettings\(\)\}/);
  assert.match(main, /void initializeTellerSettings\(\)/);
  const { renderBankAccountsPage } = await import('../src/bank_accounts.ts');
  assert.match(renderBankAccountsPage({ displayName: 'User', username: 'user' }), /href="\/settings"/);
});

test('settings shows safe validation feedback and cancels credential removal without a write', async () => {
  const dom = settingsDom(); let requests = 0;
  globalThis.window = { confirm: () => false };
  globalThis.fetch = async () => ++requests === 1 ? response(saved) : { ...response({ error: 'Certificate and private key must match.' }, false), status: 400 };
  const { initializeTellerSettings } = await settings(); await initializeTellerSettings();
  await dom['clear-credentials'].emit('click'); assert.equal(requests, 1);
  await dom.form.emit('submit');
  assert.equal(dom.status.textContent, 'Certificate and private key must match.');
});

test('late file reads cannot restore private credentials after submission', async () => {
  const dom = settingsDom();
  globalThis.fetch = async () => response(saved);
  const { initializeTellerSettings } = await settings(); await initializeTellerSettings();
  let finish;
  dom['private-key-file'].files = [{ text: () => new Promise(resolve => { finish = resolve; }) }];
  const uploading = dom['private-key-file'].emit('change');
  await dom.form.emit('submit');
  finish('LATE PRIVATE KEY'); await uploading;
  assert.equal(dom['private-key'].value, '');
});

class Element {
  value = ''; textContent = ''; hidden = false; disabled = false; innerHTML = ''; dataset = {}; files = [];
  handlers = {}; classList = { toggle() {}, add() {}, remove() {} };
  addEventListener(name, handler) { this.handlers[name] = handler; }
  async emit(name) { await this.handlers[name]?.({ preventDefault() {}, currentTarget: this }); }
  querySelector() { return null; }
}
function settingsDom() {
  const ids = ['form', 'fields', 'application-id', 'environment', 'certificate', 'private-key', 'signing-key', 'certificate-status', 'private-key-status', 'status', 'clear-credentials', 'certificate-file', 'private-key-file', 'retry'];
  const nodes = Object.fromEntries(ids.map(id => [id, new Element()]));
  globalThis.document = { querySelector(selector) { return nodes[selector.replace('#teller-settings-', '').replace('#teller-', '')] ?? null; } };
  return nodes;
}
const saved = { applicationId: 'app_test', environment: 'development', hasCertificate: true, hasPrivateKey: true, signingKey: 'public', configured: true };
const response = (value, ok = true) => ({ ok, async json() { return value; } });

test('settings handlers load safe flags, upload PEM, save and wipe secrets; blanks preserve and clear is explicit', async () => {
  const dom = settingsDom(); const calls = [];
  globalThis.window = { confirm: () => true };
  globalThis.fetch = async (url, options) => { calls.push([url, options]); return response(saved); };
  const { initializeTellerSettings } = await settings();
  assert.equal(typeof initializeTellerSettings, 'function');
  await initializeTellerSettings();
  assert.equal(dom['application-id'].value, 'app_test');
  assert.equal(dom.environment.value, 'development');
  assert.equal(dom['certificate-status'].textContent, 'Saved');
  assert.equal(dom['private-key'].value, '');
  dom['private-key-file'].files = [{ text: async () => 'PRIVATE PEM' }];
  await dom['private-key-file'].emit('change');
  assert.equal(dom['private-key'].value, 'PRIVATE PEM');
  dom.certificate.value = 'CERT PEM';
  await dom.form.emit('submit');
  assert.deepEqual(JSON.parse(calls[1][1].body), { applicationId: 'app_test', environment: 'development', certificate: 'CERT PEM', privateKey: 'PRIVATE PEM', signingKey: 'public' });
  assert.equal(calls[1][0], '/api/settings/teller');
  assert.equal(calls[1][1].method, 'PUT');
  assert.equal(dom['private-key'].value, ''); assert.equal(dom.certificate.value, '');
  await dom.form.emit('submit');
  assert.equal(JSON.parse(calls[3][1].body).privateKey, '');
  await dom['clear-credentials'].emit('click');
  assert.deepEqual(JSON.parse(calls[5][1].body), { clearCredentials: true });
  assert.equal(dom.fields.disabled, false);
});

test('settings failure wipes submitted private credentials and restores controls without leaking server errors', async () => {
  const dom = settingsDom(); let requests = 0;
  globalThis.fetch = async () => ++requests === 1 ? response(saved) : response({ error: 'PRIVATE PEM server diagnostic' }, false);
  const { initializeTellerSettings } = await settings(); await initializeTellerSettings();
  dom['private-key'].value = 'PRIVATE PEM';
  await dom.form.emit('submit');
  assert.equal(dom['private-key'].value, '');
  assert.doesNotMatch(dom.status.textContent, /PRIVATE PEM/);
  assert.equal(dom.fields.disabled, false);
});
