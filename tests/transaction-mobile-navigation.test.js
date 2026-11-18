import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import * as navigation from "../src/navigation.ts";

const pages = ["overview", "transactions", "real-estate", "accounts", "settings"];

for (const activePage of pages) {
  test(`mobile navigation marks only ${activePage} as the current page`, () => {
    const rendered = links(navigation.renderMobileNavigation(activePage));
    assert.deepEqual(rendered.filter(({ current }) => current).map(({ href }) => href), activePage === "settings" ? [] : [destinations[pages.indexOf(activePage)]]);
  });
}

test("mobile navigation uses four distinct decorative inline SVG icons", () => {
  const html = navigation.renderMobileNavigation("transactions");
  const icons = [...html.matchAll(/<svg\b([^>]*)>([\s\S]*?)<\/svg>/g)];
  assert.equal(icons.length, 4);
  assert.equal(new Set(icons.map(([, , drawing]) => drawing)).size, 4);
  for (const [, attributes, drawing] of icons) {
    assert.match(attributes, /aria-hidden="true"/);
    assert.match(attributes, /focusable="false"/);
    assert.match(attributes, /viewBox="0 0 24 24"/);
    assert.match(drawing, /<(path|rect|circle)\b/);
    assert.doesNotMatch(drawing, /<use\b|<text\b/);
  }
  assert.doesNotMatch(html, /[◫↕⌂▣⚙]/u);
});
const destinations = ["/dashboard", "/transactions", "/real-estate", "/accounts"];
const labels = ["Overview", "Transactions", "Real Estate", "Accounts"];

function links(html) {
  return [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)].map(([, attributes, body]) => ({
    href: attributes.match(/href="([^"]+)"/)?.[1],
    current: attributes.includes('aria-current="page"'),
    label: body.replace(/<svg\b[\s\S]*?<\/svg>/g, "").replace(/<span\b[^>]*aria-hidden="true"[^>]*>[\s\S]*?<\/span>/g, "").replace(/<[^>]+>/g, "").trim(),
    body,
  }));
}

test("mobile navigation exposes every shared destination in the same order", () => {
  assert.equal(typeof navigation.renderMobileNavigation, "function");
  const html = navigation.renderMobileNavigation("transactions");
  assert.match(html, /<nav\b[^>]*class="mobile-navigation"[^>]*aria-label="Mobile navigation"/);
  const mobile = links(html);
  assert.deepEqual(mobile.map(({ href }) => href), destinations);
  assert.deepEqual(mobile.map(({ label }) => label), labels);
  assert.deepEqual(mobile.map(({ href, label }) => ({ href, label })), links(navigation.renderMainNavigation("transactions")).map(({ href, label }) => ({ href, label })));
});

test("shared app navigation renders desktop and mobile links outside the sidebar with escaped profile data", () => {
  assert.equal(typeof navigation.renderAppNavigation, "function");
  for (const activePage of pages) {
    const html = navigation.renderAppNavigation({ displayName: '<Test & User>', username: 'test"user' }, activePage);
    assert.match(html, /&lt;Test &amp; User&gt;/);
    assert.match(html, /@test&quot;user/);
    assert.match(html, /<\/aside>\s*<nav class="mobile-navigation"/);
    const mobile = html.match(/<nav class="mobile-navigation"[^>]*>([\s\S]*?)<\/nav>/)?.[1];
    assert.ok(mobile);
    assert.deepEqual(links(mobile), links(navigation.renderMobileNavigation(activePage)));
    assert.equal((html.match(/aria-label="Mobile navigation"/g) ?? []).length, 1);
    assert.doesNotMatch(html, /mobile-menu-toggle/);
  }
});


test("Settings is an accessible profile gear, not a workspace or bottom-bar destination", () => {
  for (const activePage of pages) {
    const html = navigation.renderAppNavigation({ displayName: "Alex Morgan", username: "alex" }, activePage);
    const gears = [...html.matchAll(/<a class="(settings-gear|mobile-gear)(?: active)?"([^>]*)>([\s\S]*?)<\/a>/g)];
    assert.equal(gears.length, 2);
    for (const [, , attributes, drawing] of gears) {
      assert.match(attributes, /href="\/settings"/);
      assert.match(attributes, /aria-label="Settings"/);
      assert.equal(attributes.includes('aria-current="page"'), activePage === "settings");
      assert.match(drawing, /<svg[^>]*aria-hidden="true"[^>]*focusable="false"/);
    }
    assert.match(html, /class="profile-copy">[\s\S]*?<\/div>\s*<a class="settings-gear/);
    assert.match(html, /class="mobile-profile">[\s\S]*?Alex Morgan[\s\S]*?class="mobile-gear/);
    assert.equal((html.match(/aria-label="Finance home"/g) ?? []).length, 1);
    assert.doesNotMatch(navigation.renderMainNavigation(activePage), /\/settings/);
    assert.doesNotMatch(navigation.renderMobileNavigation(activePage), /\/settings/);
  }
});

test("profile gears and settings panels have responsive accessible styling without update UI", async () => {
  const css = await readFile(new URL("../src/style.css", import.meta.url), "utf8");
  assert.match(css, /\.mobile-profile\s*\{\s*display:\s*none/);
  assert.match(css, /\.settings-gear[\s\S]*?width:\s*44px;[\s\S]*?height:\s*44px;/);
  assert.match(css, /\.settings-gear:focus-visible/);
  assert.match(css, /@media\s*\(max-width:\s*800px\)[\s\S]*?\.mobile-profile\s*\{[^}]*display:\s*flex/);
  assert.match(css, /grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/);
  for (const selector of [".settings-heading h2", ".settings-badge"]) {
    assert.ok(css.includes(selector), `missing ${selector}`);
  }
  assert.doesNotMatch(css, /\.update-(?:heading|badge|actions)\b|\.version-row\b|#update-message\b/, 'obsolete update styles are removed');
});
