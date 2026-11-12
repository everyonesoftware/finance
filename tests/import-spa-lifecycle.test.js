import assert from "node:assert/strict";
import test from "node:test";
import { initializeAccountImport } from "../src/account-import-workflow.ts";
import { initializeBatchImport } from "../src/batch-import.ts";

class Element {
  handlers = {}; isConnected = true; value = ""; files = []; textContent = ""; innerHTML = "";
  disabled = false; hidden = false; open = false; dataset = {};
  addEventListener(type, handler) { (this.handlers[type] ??= []).push(handler); }
  async emit(type) { for (const handler of this.handlers[type] ?? []) await handler({ preventDefault() {}, currentTarget: this, target: this }); }
  querySelector(id) { return this.nodes?.[id] ?? null; }
  contains(node) { return Object.values(this.nodes ?? {}).includes(node); }
  querySelectorAll() { return []; }
  close() { this.open = false; }
  showModal() { this.open = true; }
  focus() { this.focused = true; }
}
const account = { id: "A", name: "A", institutionName: "Bank", canImport: true };
const preview = { columns: [], mapping: null, errors: [], transactions: [{ name: "Private A", amount: 1, iso_currency_code: "USD", date: "2026-01-01" }], total: 1, importable: 1, duplicates: 0 };
function setup(t, ids) {
  const a = Object.fromEntries(ids.map(id => [id, new Element()]));
  const b = Object.fromEntries(ids.map(id => [id, new Element()]));
  for (const nodes of [a, b]) for (const element of Object.values(nodes)) element.nodes = nodes;
  const document = { querySelector: id => a[id] ?? null, activeElement: null };
  const previous = globalThis.document;
  globalThis.document = document;
  t.after(() => { globalThis.document = previous; });
  const leave = () => { Object.values(a).forEach(element => { element.isConnected = false; }); document.querySelector = id => b[id] ?? null; };
  return { a, b, document, leave };
}
const importIds = ["#account-import-dialog", "#account-import-form", "#import-file", "#import-next", "#import-back", "#import-file-step", "#import-preview-step", "#account-import-error", "#import-preview-summary", "#import-preview-rows", "#import-preview-limit"];

test("an in-flight account A preview cannot populate or focus account B after navigation", async t => {
  const { a, b, leave } = setup(t, importIds);
  let complete;
  const pending = new Promise(resolve => { complete = resolve; });
  t.mock.method(globalThis, "fetch", () => pending);
  a["#import-file"].files = [new File(["file"], "statement.ofx")];
  initializeAccountImport(account, async () => assert.fail("preview cannot import"));
  const checking = a["#account-import-form"].emit("submit");
  await new Promise(resolve => setImmediate(resolve));
  leave();
  complete({ ok: true, json: async () => preview });
  await checking;
  assert.equal(b["#import-preview-summary"].textContent, "");
  assert.equal(b["#import-preview-rows"].innerHTML, "");
  assert.equal(a["#import-next"].textContent, "", "the departed workflow does not advance");
});

test("a delayed batch preview does not restore focus into a new page's mapping control", async t => {
  const ids = ["#batch-import-dialog", "#batch-import-form", "#open-batch-import", "#batch-import-files", "#batch-import-rows", "#batch-import-summary", "#batch-import-error", "#batch-import-confirm", "#batch-import-cancel", '[data-batch-account="0"]'];
  const { a, b, document, leave } = setup(t, ids);
  let complete;
  const pending = new Promise(resolve => { complete = resolve; });
  t.mock.method(globalThis, "fetch", () => pending);
  initializeBatchImport(() => [account], async () => assert.fail("preview cannot import"));
  a["#batch-import-files"].files = [new File(["file"], "statement.ofx")];
  const checking = a["#batch-import-files"].emit("change");
  await new Promise(resolve => setImmediate(resolve));
  leave();
  document.activeElement = b['[data-batch-account="0"]'];
  document.activeElement.dataset.batchAccount = "0";
  complete({ ok: true, json: async () => ({ files: [{ fileName: "statement.ofx", accountId: "A", status: "ready", errors: [], columns: [], mapping: null, total: 1, importable: 1, duplicates: 0 }] }) });
  await checking;
  assert.notEqual(b['[data-batch-account="0"]'].focused, true);
  assert.equal(a["#batch-import-summary"].textContent, "Checking files and recalculating the batch…", "a departed batch cannot render a later preview");
});

const batchIds = ["#batch-import-dialog", "#batch-import-form", "#open-batch-import", "#batch-import-files", "#batch-import-rows", "#batch-import-summary", "#batch-import-error", "#batch-import-confirm", "#batch-import-cancel", '[data-batch-account="0"]'];
const batchPreview = { files: [{ fileName: "statement.ofx", accountId: "A", status: "ready", errors: [], columns: [], mapping: null, total: 1, importable: 1, duplicates: 0 }] };
const tick = () => new Promise(resolve => setImmediate(resolve));
const response = payload => ({ ok: true, json: async () => payload });
const snapshot = nodes => Object.fromEntries(Object.entries(nodes).map(([id, el]) => [id, [el.textContent, el.innerHTML, el.disabled, el.open, el.hidden, el.value, el.required, el.focused]]));

test("connected account preview uses its captured form rather than global matching IDs", async t => {
  const { a, b, document } = setup(t, importIds);
  let complete;
  t.mock.method(globalThis, "fetch", () => new Promise(resolve => { complete = resolve; }));
  initializeAccountImport(account, async () => assert.fail("preview cannot import"));
  a["#import-file"].files = [new File(["file"], "statement.ofx")];
  const checking = a["#account-import-form"].emit("submit");
  await tick();
  document.querySelector = id => b[id] ?? null;
  complete(response(preview));
  await checking;
  assert.match(a["#import-preview-summary"].textContent, /1 transactions found/);
  assert.match(a["#import-preview-rows"].innerHTML, /Private A/);
  assert.equal(b["#import-preview-summary"].textContent, "");
  assert.equal(b["#import-preview-rows"].innerHTML, "");
});

test("connected batch preview restores focus only within its captured form", async t => {
  const { a, b, document } = setup(t, batchIds);
  let complete;
  t.mock.method(globalThis, "fetch", () => new Promise(resolve => { complete = resolve; }));
  initializeBatchImport(() => [account], async () => assert.fail("preview cannot import"));
  a['[data-batch-account="0"]'].dataset.batchAccount = "0";
  document.activeElement = a['[data-batch-account="0"]'];
  a["#batch-import-files"].files = [new File(["file"], "statement.ofx")];
  const checking = a["#batch-import-files"].emit("change");
  await tick();
  document.querySelector = id => b[id] ?? null;
  document.activeElement = b['[data-batch-account="0"]'];
  document.activeElement.dataset.batchAccount = "0";
  complete(response(batchPreview));
  await checking;
  assert.equal(a['[data-batch-account="0"]'].focused, true);
  assert.notEqual(b['[data-batch-account="0"]'].focused, true);
});

for (const departure of ["abort", "detach"]) test(`batch refresh failure after ${departure} cannot reopen the dialog`, async t => {
  const { a, b, leave } = setup(t, batchIds);
  const controller = new AbortController();
  let rejectRefresh, callbacks = 0;
  const refresh = new Promise((_, reject) => { rejectRefresh = reject; });
  t.mock.method(globalThis, "fetch", async url => response(url.endsWith("/preview") ? batchPreview : { imported: 1, skipped: 0 }));
  initializeBatchImport(() => [account], async () => { callbacks++; await refresh; }, controller.signal);
  await a["#open-batch-import"].emit("click");
  a["#batch-import-files"].files = [new File(["file"], "statement.ofx")];
  await a["#batch-import-files"].emit("change");
  const importing = a["#batch-import-form"].emit("submit");
  await tick();
  assert.equal(callbacks, 1, "refresh began before departure");
  assert.equal(a["#batch-import-dialog"].open, false);
  const before = snapshot(a);
  if (departure === "abort") controller.abort(); else leave();
  rejectRefresh(Error("late refresh failure"));
  await importing;
  assert.deepEqual(snapshot(a), before);
  assert.ok(Object.values(b).every(el => !el.open && !el.focused && !el.textContent));
});

for (const kind of ["account", "batch"]) for (const departure of ["abort", "detach"]) {
  for (const phase of ["decode", "preview", "commit"]) for (const fails of [false, true]) test(`${kind} ${phase} ${fails ? "failure" : "completion"} is inert after ${departure}`, async t => {
    const batch = kind === "batch";
    const { a, b, leave } = setup(t, batch ? batchIds : importIds);
    const controller = new AbortController();
    let complete, callbacks = 0;
    const pending = new Promise(resolve => { complete = resolve; });
    const calls = [];
    t.mock.method(globalThis, "fetch", async (url, options) => {
      calls.push([url, options]);
      if ((phase === "preview" && url.endsWith("/preview")) || (phase === "commit" && !url.endsWith("/preview"))) return pending;
      return response(batch ? batchPreview : preview);
    });
    const onImported = async () => { callbacks++; throw Error("must not refresh"); };
    if (batch) initializeBatchImport(() => [account], onImported, controller.signal);
    else initializeAccountImport(account, onImported, controller.signal);
    const file = new File(["file"], "statement.ofx");
    if (phase === "decode") file.arrayBuffer = () => pending;
    a[batch ? "#batch-import-files" : "#import-file"].files = [file];
    const form = a[batch ? "#batch-import-form" : "#account-import-form"];
    let running = batch ? a["#batch-import-files"].emit("change") : form.emit("submit");
    if (phase === "commit") { await running; running = form.emit("submit"); }
    await tick();
    const before = snapshot(a);
    if (departure === "abort") controller.abort(); else leave();
    complete(fails ? Promise.reject(Error("late failure")) : phase === "decode" ? new TextEncoder().encode("file").buffer : response(phase === "preview" ? batch ? batchPreview : preview : { imported: 1, skipped: 0, account }));
    await running;
    assert.equal(callbacks, 0);
    assert.deepEqual(snapshot(a), before);
    assert.ok(Object.values(b).every(el => !el.focused && !el.open && !el.textContent && !el.innerHTML));
    assert.equal(calls.length, phase === "decode" ? 0 : phase === "preview" ? 1 : 2);
    assert.ok(calls.every(([, options]) => !options.signal), "already-started writes must not be aborted");
    await form.emit("submit");
    assert.equal(calls.length, phase === "decode" ? 0 : phase === "preview" ? 1 : 2, "departed forms cannot start writes");
  });
}
