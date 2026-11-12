import assert from "node:assert/strict";
import test from "node:test";

const routerModule = await import("../src/router.ts").catch(() => ({}));

function browser() {
  const listeners = new Map();
  const location = new URL("https://finance.example/dashboard");
  const entries = [];
  const window = {
    location,
    history: {
      pushState(_state, _title, url) { entries.push(["push", url]); location.href = new URL(url, location).href; },
      replaceState(_state, _title, url) { entries.push(["replace", url]); location.href = new URL(url, location).href; },
    },
    addEventListener(type, handler) { listeners.set(type, handler); },
    removeEventListener() {},
    scrollTo() {},
  };
  const document = {
    addEventListener(type, handler) { listeners.set(type, handler); },
    removeEventListener() {},
  };
  let renders = 0;
  return { window, document, entries, listeners, render: () => { renders++; }, get renders() { return renders; } };
}

function setup() {
  assert.equal(typeof routerModule.createClientRouter, "function", "a client router must replace document navigation");
  const b = browser();
  return { b, router: routerModule.createClientRouter(b.render, b.window, b.document) };
}

function click(href, extra = {}, attributes = {}) {
  const anchor = {
    href,
    target: attributes.target ?? "",
    hasAttribute(name) { return name === "download" && attributes.download === true; },
    getAttribute(name) { return name === "href" ? href : null; },
  };
  return { button: 0, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, target: { closest: () => anchor }, ...extra };
}

test("client navigation uses history and renders without assigning window.location", () => {
  const { b, router } = setup();
  router.navigate("/transactions");
  assert.deepEqual(b.entries, [["push", "/transactions"]]);
  assert.equal(b.window.location.pathname, "/transactions");
  assert.equal(b.renders, 1);
  router.navigate("/transactions");
  assert.equal(b.renders, 1, "same destination must not erase controls or reload data");
  router.navigate("/settings", { replace: true });
  assert.deepEqual(b.entries.at(-1), ["replace", "/settings"]);
  b.listeners.get("popstate")();
  assert.equal(b.renders, 3, "Back and Forward render the current URL");
});

test("same-origin page links are intercepted, including account details and signup", () => {
  for (const path of ["/", "/?mode=signup", "/dashboard", "/transactions", "/settings", "/accounts", "/accounts/account%2Fone", "/real-estate"]) {
    const { b } = setup();
    const event = click("https://finance.example" + path);
    b.listeners.get("click")(event);
    assert.equal(event.defaultPrevented, true, path);
  }
});

test("modified, external, API, download, new-tab and same-page fragment clicks remain native", () => {
  for (const event of [
    click("https://finance.example/settings", { ctrlKey: true }),
    click("https://finance.example/settings", { metaKey: true }),
    click("https://finance.example/settings", { shiftKey: true }),
    click("https://finance.example/settings", { altKey: true }),
    click("https://finance.example/settings", { button: 1 }),
    click("https://finance.example/settings", { defaultPrevented: true }),
    click("https://other.example/settings"),
    click("https://finance.example/api/auth/get-session"),
    click("https://finance.example/settings", {}, { target: "_blank" }),
    click("https://finance.example/settings", {}, { download: true }),
    click("https://finance.example/dashboard#transactions"),
    click("mailto:person@example.test"),
    click("https://finance.example/unknown"),
  ]) {
    const { b } = setup();
    const wasPrevented = event.defaultPrevented;
    b.listeners.get("click")(event);
    assert.equal(event.defaultPrevented, wasPrevented);
    assert.equal(b.renders, 0);
  }
});
