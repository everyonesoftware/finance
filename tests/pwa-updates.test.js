import assert from "node:assert/strict";
import test from "node:test";
const pwa = await import("../src/pwa.ts").catch(() => ({}));

class Events {
  listeners = new Map();
  addEventListener(name, callback) { const items = this.listeners.get(name) ?? []; items.push(callback); this.listeners.set(name, items); }
  removeEventListener(name, callback) { this.listeners.set(name, (this.listeners.get(name) ?? []).filter(item => item !== callback)); }
  emit(name) { for (const callback of this.listeners.get(name) ?? []) callback(); }
}
function setup(options = {}) {
  assert.equal(typeof pwa.AppUpdates, "function", "Settings needs a real PWA update controller");
  const sw = new Events();
  const registration = new Events();
  registration.waiting = null;
  registration.installing = null;
  registration.active = {};
  let updates = 0, registrations = 0, requests = 0, reloads = 0;
  registration.update = async () => { updates++; if (options.updateError) throw new Error("network"); };
  sw.register = async (url, config) => {
    registrations++;
    assert.equal(url, "/sw.js");
    assert.equal(config.updateViaCache, "none");
    if (options.registrationError) throw new Error("registration");
    return registration;
  };
  sw.controller = {};
  const controller = new pwa.AppUpdates("100", {
    serviceWorker: sw,
    enabled: options.enabled ?? true,
    isOnline: () => options.online ?? true,
    fetch: async (url, config) => {
      requests++;
      assert.equal(url, "/version.json");
      assert.equal(config.cache, "no-store");
      if (options.fetchError) throw new Error("offline");
      return { ok: true, json: async () => ({ version: options.version ?? "100" }) };
    },
    reload: () => { reloads++; },
  });
  return { controller, sw, registration, get counts() { return { updates, registrations, requests, reloads }; } };
}

test("checking uses an uncached version and real worker update; concurrent checks are deduplicated", async () => {
  const s = setup();
  const states = [];
  const stop = s.controller.subscribe(state => states.push(state.status));
  await Promise.all([s.controller.check(), s.controller.check()]);
  assert.equal(s.controller.snapshot.status, "current");
  assert.deepEqual(s.counts, { updates: 1, registrations: 1, requests: 1, reloads: 0 });
  assert.ok(states.includes("checking"));
  stop();
});

test("a new deployed version is available but never automatically reloads", async () => {
  const s = setup({ version: "101" });
  await s.controller.check();
  assert.equal(s.controller.snapshot.status, "available");
  assert.equal(s.controller.snapshot.version, "101");
  s.sw.emit("controllerchange");
  assert.equal(s.counts.reloads, 0);
  s.controller.defer();
  assert.equal(s.controller.snapshot.status, "available");
  assert.match(s.controller.snapshot.message, /postponed/i);
  s.controller.apply();
  assert.equal(s.counts.reloads, 1, "an explicit reload can update a shell without a waiting worker");
});

test("waiting workers activate only on explicit apply and reload only after controller change", async () => {
  const s = setup();
  const messages = [];
  s.registration.waiting = { state: "installed", postMessage: message => messages.push(message) };
  await s.controller.check();
  assert.equal(s.controller.snapshot.status, "available");
  assert.equal(s.counts.reloads, 0);
  assert.deepEqual(messages, []);
  s.controller.apply();
  assert.deepEqual(messages, [{ type: "SKIP_WAITING" }]);
  assert.equal(s.counts.reloads, 0);
  s.sw.emit("controllerchange");
  assert.equal(s.counts.reloads, 1);
  s.sw.emit("controllerchange");
  assert.equal(s.counts.reloads, 1);
});

test("offline, registration, metadata and worker failures never claim up-to-date", async () => {
  for (const [options, expected] of [[{ online: false }, "offline"], [{ registrationError: true }, "error"], [{ fetchError: true }, "error"], [{ updateError: true }, "error"], [{ enabled: false }, "unsupported"]]) {
    const s = setup(options);
    await s.controller.check();
    assert.equal(s.controller.snapshot.status, expected);
    assert.equal(s.counts.reloads, 0);
    if (options.online === false) assert.equal(s.counts.requests, 0);
  }
});

test("a downloading worker is not reported current and a failed install remains retryable", async () => {
  for (const terminal of ["installed", "redundant"]) {
    const s = setup();
    await s.controller.start();
    const worker = new Events();
    worker.state = "installing";
    s.registration.installing = worker;
    const checking = s.controller.check();
    // Drain the uncached metadata read and registration update promises.
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(s.controller.snapshot.status, "checking");
    worker.state = terminal;
    if (terminal === "installed") s.registration.waiting = worker;
    worker.emit("statechange");
    await checking;
    assert.equal(s.controller.snapshot.status, terminal === "installed" ? "available" : "error");
    assert.equal(s.counts.reloads, 0);
  }
});

test("a failed registration can be retried without reloading the application", async () => {
  const options = { registrationError: true };
  const s = setup(options);
  await s.controller.start();
  assert.equal(s.controller.snapshot.status, "error");
  options.registrationError = false;
  await s.controller.check();
  assert.equal(s.controller.snapshot.status, "current");
  assert.equal(s.counts.registrations, 2);
});

test("first installation does not offer an update or hide the manual check action", async () => {
  const s = setup();
  s.registration.active = null;
  await s.controller.start();
  const worker = new Events();
  worker.state = "installing";
  s.registration.installing = worker;
  s.registration.emit("updatefound");
  worker.state = "installed";
  s.registration.waiting = worker;
  worker.emit("statechange");
  assert.equal(s.controller.snapshot.status, "idle");
  assert.equal(s.counts.reloads, 0);
});
