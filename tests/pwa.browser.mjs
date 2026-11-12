import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdtemp, rm, mkdir } from "node:fs/promises";
import { join, extname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright";

// Isolated browser-only fixtures. No user database, credentials, or real financial APIs.
const dist = resolve(process.env.FINANCE_BROWSER_DIST ?? "dist");
const temporary = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "finance-pwa-browser-"));
const account = { id: "demo-checking", providerAccountId: "demo-checking", itemId: "demo-item", name: "Checking", officialName: null, institutionName: "Example Bank", mask: "1234", type: "depository", subtype: "checking", currentBalance: 200, availableBalance: 200, currencyCode: "USD", canImport: true, updatedAt: "2026-11-01T12:00:00Z" };
const otherAccount = { ...account, id: 'demo-savings', providerAccountId: 'demo-savings', name: 'Savings', mask: '5678', subtype: 'savings', currentBalance: 0, availableBalance: 0 };
const accounts = [account, otherAccount];
const transactions = Array.from({ length: 70 }, (_, i) => ({ transaction_id: `demo-${i}`, account_id: account.id, name: `Sample transaction ${i}`, amount: i + 1, date: "2026-11-01", iso_currency_code: "USD" }));
const user = { id: "demo-user", name: "Preview User", username: "preview", displayUsername: "preview", email: "preview@example.test", emailVerified: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
let signedIn = true;
let release = 1;
let offlineMutationAttempts = 0;
let mutations = 0;
let releaseAccountPreview;
let releaseBatchPreview;
let holdBatchPreview = false;
const mime = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".webmanifest": "application/manifest+json", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml" };
const server = createServer(async (req, res) => {
  const path = new URL(req.url, "http://localhost").pathname;
  res.setHeader("Cache-Control", "no-store");
  const json = body => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(body)); };
  try {
    if (path.startsWith("/api/")) {
      if (req.method !== "GET") mutations++;
      if (path === "/api/offline-test") { offlineMutationAttempts++; json({ success: true }); return; }
      if (path === "/api/auth/get-session") { json(signedIn ? { user, session: { id: "demo-session", userId: user.id, token: "browser-fixture-only", expiresAt: "2099-01-01T00:00:00Z" } } : null); return; }
      if (path === "/api/auth/update-user") {
        let body = ""; for await (const chunk of req) body += chunk;
        Object.assign(user, JSON.parse(body)); json({ user, status: true }); return;
      }
      if (path === "/api/auth/change-password") { json({ token: null, user }); return; }
      if (path === "/api/auth/sign-out") { signedIn = false; json({ success: true }); return; }
      if (path === "/api/auth/sign-in/username") { signedIn = true; json({ token: "browser-fixture-only", user }); return; }
      if (path === '/api/accounts/demo-checking/import/preview') {
        await new Promise(resolve => { releaseAccountPreview = resolve; });
        json({ columns: [], mapping: null, errors: [], transactions: [{ name: 'Private checking preview', amount: 5, date: '2026-11-01', iso_currency_code: 'USD' }], total: 1, importable: 1, duplicates: 0 }); return;
      }
      if (path === '/api/accounts/import-batch/preview') {
        let body = ''; for await (const chunk of req) body += chunk;
        const request = JSON.parse(body);
        if (holdBatchPreview) { holdBatchPreview = false; await new Promise(resolve => { releaseBatchPreview = resolve; }); }
        json({ files: request.files.map(file => ({ fileName: file.fileName, accountId: file.accountId ?? account.id, status: 'ready', reason: 'Browser fixture', errors: [], columns: [], mapping: null, total: 1, importable: 1, duplicates: 0 })) }); return;
      }
      if (path === "/api/accounts/transactions/all") { json({ accounts, transactions, configured: false }); return; }
      if (path === "/api/accounts/net-worth") { json({ currencyCode: "USD", total: 200, accountCount: 2, includedAccountCount: 2, excludedAccountCount: 0, unknownBalanceCount: 0, points: [{ date: new Date().toISOString().slice(0, 10), total: 200 }] }); return; }
      if (path === "/api/accounts/demo-checking/transactions") { json({ account, accounts, transactions, configured: false }); return; }
      if (path === "/api/accounts/demo-savings/transactions") { json({ account: otherAccount, accounts, transactions: [], configured: false }); return; }
      if (path === "/api/accounts") { json({ accounts, configured: false }); return; }
      if (path === "/api/real-estate") { json({ properties: [] }); return; }
      res.statusCode = 404; json({ error: "Unknown fixture API" }); return;
    }
    if (path === "/version.json") {
      const metadata = JSON.parse(await readFile(join(dist, "version.json"), "utf8"));
      json(release === 1 ? metadata : { ...metadata, version: "browser-test-next" }); return;
    }
    const file = path === "/" || !extname(path) ? "/index.html" : path;
    const target = resolve(dist, "." + file);
    if (!target.startsWith(dist + "/") && !target.startsWith(dist + "\\")) { res.statusCode = 404; res.end(); return; }
    let bytes = await readFile(target);
    if (path === "/sw.js" && release === 2) bytes = Buffer.concat([bytes, Buffer.from("\n// Browser-only alternate release 2\n")]);
    res.setHeader("Content-Type", mime[extname(file)] ?? "application/octet-stream");
    res.end(bytes);
  } catch { res.statusCode = 404; res.end("Not found"); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
async function waitForFixture(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail('The expected fixture request did not arrive');
}
let context;
const errors = [];
try {
  const browserOptions = { headless: true, viewport: { width: 1440, height: 960 }, serviceWorkers: "allow" };
  if (process.platform === "win32") browserOptions.channel = "msedge";
  if (process.env.PLAYWRIGHT_CHANNEL) browserOptions.channel = process.env.PLAYWRIGHT_CHANNEL;
  context = await chromium.launchPersistentContext(join(temporary, "profile"), browserOptions);
  const page = context.pages()[0] ?? await context.newPage();
  page.on("pageerror", error => errors.push(error.message));
  let documentRequests = 0;
  page.on("request", request => { if (request.isNavigationRequest() && request.frame() === page.mainFrame()) documentRequests++; });
  await page.goto(origin + "/dashboard");
  await page.locator("#overview-total-balance").filter({ hasText: "$200.00" }).waitFor();
  await page.evaluate(() => { window.spaDocumentIdentity = "unchanged"; window.originalSidebar = document.querySelector(".sidebar"); });
  await page.locator('.navigation a[href="/transactions"]').click();
  await page.locator("#all-transactions-list .transaction-row").first().waitFor();
  assert.equal(await page.evaluate(() => window.spaDocumentIdentity), "unchanged", "navigation must not reload the document");
  assert.equal(await page.evaluate(() => window.originalSidebar === document.querySelector('.sidebar')), true, "the shell stays mounted");
  await page.locator("#transaction-search").fill("Sample transaction 69");
  await page.locator("#all-transactions-list").filter({ hasText: "Sample transaction 69" }).waitFor();
  await page.locator('.settings-gear:visible').click();
  await page.locator("#check-update").waitFor();
  await page.goBack();
  await page.locator("#transaction-search").waitFor();
  await page.goForward();
  await page.locator("#check-update").waitFor();
  await page.locator('.navigation a[href="/accounts"]').click();
  await page.locator('#connected-accounts a[href="/accounts/demo-checking"]').first().click();
  await page.locator('#account-detail-content').filter({ hasText: 'Sample transaction' }).waitFor();
  await page.locator('.account-all-link').click();
  await page.locator('#connected-accounts').filter({ hasText: 'Example Bank' }).waitFor();
  await page.locator('.navigation a[href="/real-estate"]').click();
  await page.locator('#real-estate-properties').waitFor();
  await page.locator('.settings-gear:visible').click();
  await page.locator('#check-update').waitFor();
  assert.equal(documentRequests, 1, "links and Back/Forward must not request another document");
  console.log("PASS single-page navigation, persistent sidebar, search, Back/Forward, account details and Real Estate");

  const deepLink = await context.newPage();
  await deepLink.goto(origin + '/accounts/demo-checking');
  await deepLink.locator('#account-detail-content').filter({ hasText: 'Sample transaction' }).waitFor();
  await deepLink.reload();
  await deepLink.locator('#account-detail-content').filter({ hasText: 'Sample transaction' }).waitFor();
  await deepLink.close();
  console.log('PASS direct account deep link and hard reload');

  const lifecycle = await context.newPage();
  lifecycle.on('pageerror', error => errors.push(error.message));
  await lifecycle.goto(origin + '/accounts');
  await lifecycle.locator('#connected-accounts a[href="/accounts/demo-checking"]').first().click();
  await lifecycle.locator('#import-transactions').click();
  await lifecycle.locator('#import-file').setInputFiles({ name: 'checking.ofx', mimeType: 'application/x-ofx', buffer: Buffer.from('browser-only sample') });
  await lifecycle.locator('#import-next').click();
  await waitForFixture(() => Boolean(releaseAccountPreview));
  assert.equal(typeof releaseAccountPreview, 'function');
  await lifecycle.goBack();
  await lifecycle.locator('#connected-accounts a[href="/accounts/demo-savings"]').first().click();
  await lifecycle.locator('#import-transactions').waitFor();
  const untouchedSummary = await lifecycle.locator('#import-preview-summary').innerText();
  const finishedPreview = lifecycle.waitForResponse(response => response.url().endsWith('/demo-checking/import/preview'));
  releaseAccountPreview();
  await finishedPreview;
  await lifecycle.waitForTimeout(50);
  assert.equal(await lifecycle.locator('#import-preview-summary').innerText(), untouchedSummary);
  assert.doesNotMatch(await lifecycle.locator('#import-preview-rows').innerText(), /Private checking preview/);
  await lifecycle.locator('.navigation a[href="/transactions"]').click();
  await lifecycle.locator('#transaction-filters-trigger:not([disabled])').waitFor({ state: 'attached' });
  await lifecycle.locator('#open-batch-import').click();
  const sampleFile = { name: 'batch.ofx', mimeType: 'application/x-ofx', buffer: Buffer.from('browser-only sample') };
  await lifecycle.locator('#batch-import-files').setInputFiles(sampleFile);
  await lifecycle.locator('#batch-import-confirm:not([disabled])').waitFor();
  holdBatchPreview = true;
  await lifecycle.locator('[data-batch-account="0"]').selectOption(otherAccount.id);
  await waitForFixture(() => Boolean(releaseBatchPreview));
  assert.equal(typeof releaseBatchPreview, 'function');
  await lifecycle.goBack();
  await lifecycle.locator('#import-transactions').waitFor();
  await lifecycle.locator('.navigation a[href="/transactions"]').click();
  await lifecycle.locator('#transaction-filters-trigger:not([disabled])').waitFor({ state: 'attached' });
  await lifecycle.locator('#open-batch-import').click();
  await lifecycle.locator('#batch-import-files').setInputFiles(sampleFile);
  await lifecycle.locator('#batch-import-confirm:not([disabled])').waitFor();
  await lifecycle.locator('#batch-import-cancel').focus();
  const finishedBatch = lifecycle.waitForResponse(response => response.url().endsWith('/import-batch/preview'));
  releaseBatchPreview();
  await finishedBatch;
  await lifecycle.waitForTimeout(50);
  assert.equal(await lifecycle.evaluate(() => document.activeElement.id), 'batch-import-cancel');
  await lifecycle.close();
  console.log('PASS real file-input previews remain isolated across account/page navigation');

  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
  await page.locator("#check-update").click();
  await page.locator("#update-badge").filter({ hasText: "Up to date" }).waitFor();
  const cdp = await context.newCDPSession(page);
  const manifest = await cdp.send("Page.getAppManifest");
  assert.equal(manifest.errors.length, 0, JSON.stringify(manifest.errors));
  const installability = await cdp.send("Page.getInstallabilityErrors");
  assert.deepEqual(installability.installabilityErrors, [], JSON.stringify(installability));
  const caches = await page.evaluate(async () => {
    const result = [];
    for (const name of await window.caches.keys()) {
      for (const request of await (await window.caches.open(name)).keys()) result.push(new URL(request.url).pathname);
    }
    return result;
  });
  assert.ok(caches.includes("/offline.html"));
  assert.ok(caches.every(path => path === "/offline.html" || /\.(png|svg|webmanifest)$/.test(path)), JSON.stringify(caches));
  console.log("PASS real worker registration, manual current check, manifest/installability, public-only cache", JSON.stringify(caches));

  const other = await context.newPage();
  await other.goto(origin + "/settings");
  await other.locator("#check-update").waitFor();
  await other.evaluate(() => { window.otherDocumentIdentity = "stable"; });
  release = 2;
  await page.locator("#check-update").click();
  await page.locator("#update-badge").filter({ hasText: "Update available" }).waitFor();
  await page.waitForFunction(async () => Boolean((await navigator.serviceWorker.getRegistration()).waiting));
  assert.equal(documentRequests, 1, "discovery must not reload");
  await page.locator("#later-update").click();
  assert.equal(documentRequests, 1, "Later must not reload");
  await page.locator("#check-update").click();
  await page.locator("#reload-update").waitFor({ state: "visible" });
  await Promise.all([page.waitForEvent("load"), page.locator("#reload-update").click()]);
  await page.locator("#check-update").waitFor();
  assert.equal(documentRequests, 2, "only explicit apply reloads");
  assert.equal(await other.evaluate(() => window.otherDocumentIdentity), "stable", "applying in another tab must not discard this tab");
  await other.close();
  console.log("PASS real waiting worker, Later, explicit activation/reload, other-tab draft safety");

  await context.setOffline(true);
  await page.locator("#check-update").click();
  await page.locator("#update-badge").filter({ hasText: "Offline" }).waitFor();
  const before = mutations;
  assert.equal(await page.evaluate(async () => { try { await fetch('/api/offline-test', { method: 'POST' }); return true; } catch { return false; } }), false);
  assert.equal(await page.evaluate(async () => { try { await fetch('/api/accounts', { cache:'no-store' }); return true; } catch { return false; } }), false);
  await page.goto(origin + "/accounts");
  assert.match(await page.locator("body").innerText(), /offline|connection|connect/i);
  assert.doesNotMatch(await page.locator("body").innerText(), /Sample transaction|Preview User|\$200/);
  await context.setOffline(false);
  await page.reload();
  await page.locator("#connected-accounts").filter({ hasText: "Example Bank" }).waitFor();
  assert.equal(mutations, before);
  assert.equal(offlineMutationAttempts, 0);
  console.log("PASS offline navigation, uncached private API, rejected mutations, reconnect without replay");

  for (const width of [320,390,801,1440]) {
    await page.setViewportSize({ width, height: 844 });
    await page.locator(width <= 800 ? '.mobile-navigation a[href="/transactions"]' : '.navigation a[href="/transactions"]').click();
    await page.locator("#transaction-search").waitFor();
    await page.waitForTimeout(70);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, `Transactions overflow at ${width}`);
    const gear = page.locator('.settings-gear:visible, .mobile-gear:visible');
    assert.equal(await gear.count(), 1, `one visible settings gear at ${width}`);
    const box = await gear.boundingBox();
    assert.ok(box.width >=44 && box.height >=44);
    await gear.click();
    await page.locator("#check-update").waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, `Settings overflow at ${width}`);
    if (process.env.UI_SCREENSHOTS && [390,1440].includes(width)) {
      await mkdir(process.env.UI_SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: join(process.env.UI_SCREENSHOTS, `finance-settings-${width}.png`) });
    }
  }
  console.log("PASS 320/390/801/1440px navigation, gear targets, Transactions/Settings layout");
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.locator('#profile-form input[name="name"]').fill("Changed Preview");
  await page.locator('#profile-form button[type="submit"]').click();
  await page.locator("#settings-message").filter({ hasText: "Profile saved" }).waitFor();
  assert.equal(user.name, "Changed Preview");
  await page.locator('#password-form input[name="currentPassword"]').fill('browser-fixture-old');
  await page.locator('#password-form input[name="newPassword"]').fill('browser-fixture-new');
  await page.locator('#password-form input[name="confirmPassword"]').fill('browser-fixture-wrong');
  await page.locator('#password-form button[type="submit"]').click();
  await page.locator('#settings-message').filter({ hasText: 'The passwords do not match' }).waitFor();
  await page.locator('#password-form input[name="confirmPassword"]').fill('browser-fixture-new');
  await page.locator('#password-form button[type="submit"]').click();
  await page.locator('#settings-message').filter({ hasText: 'Password updated' }).waitFor();
  await page.locator('.logout-button').click();
  await page.locator('#auth-form').waitFor();
  await page.locator('.auth-tabs a[href="/?mode=signup"]').click();
  await page.locator('#auth-form input[name="email"]').waitFor();
  await page.locator('.auth-tabs a[href="/"]').click();
  await page.locator('#auth-form input[name="username"]').fill("preview");
  await page.locator('#auth-form input[name="password"]').fill("browser-fixture-only");
  await page.locator('#auth-form button[type="submit"]').click();
  await page.locator('#overview-total-balance').waitFor();
  console.log("PASS existing profile save, password validation/save, signup switch, logout and login through SPA (isolated API fixtures)");
  assert.deepEqual(errors, [], "no runtime exceptions");
  console.log("PASS all production browser checks");
} finally {
  await context?.close();
  await new Promise(resolve => server.close(resolve));
  await rm(temporary, { recursive: true, force: true });
}
