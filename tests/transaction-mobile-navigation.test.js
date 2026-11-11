import assert from "node:assert/strict";
import test from "node:test";
import * as navigation from "../src/navigation.ts";

const pages = ["overview", "transactions", "real-estate", "accounts", "settings"];

for (const activePage of pages) {
  test(`mobile navigation marks only ${activePage} as the current page`, () => {
    const rendered = links(navigation.renderMobileNavigation(activePage));
    assert.deepEqual(rendered.filter(({ current }) => current).map(({ href }) => href), [destinations[pages.indexOf(activePage)]]);
  });
}

test("mobile navigation uses five distinct decorative inline SVG icons", () => {
  const html = navigation.renderMobileNavigation("transactions");
  const icons = [...html.matchAll(/<svg\b([^>]*)>([\s\S]*?)<\/svg>/g)];
  assert.equal(icons.length, 5);
  assert.equal(new Set(icons.map(([, , drawing]) => drawing)).size, 5);
  for (const [, attributes, drawing] of icons) {
    assert.match(attributes, /aria-hidden="true"/);
    assert.match(attributes, /focusable="false"/);
    assert.match(attributes, /viewBox="0 0 24 24"/);
    assert.match(drawing, /<(path|rect|circle)\b/);
    assert.doesNotMatch(drawing, /<use\b|<text\b/);
  }
  assert.doesNotMatch(html, /[◫↕⌂▣⚙]/u);
});
const destinations = ["/dashboard", "/transactions", "/real-estate", "/accounts", "/settings"];
const labels = ["Overview", "Transactions", "Real Estate", "Accounts", "Settings"];

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
  assert.match(html, /<nav\b[^>]*class="transaction-mobile-navigation"[^>]*aria-label="Mobile navigation"/);
  const mobile = links(html);
  assert.deepEqual(mobile.map(({ href }) => href), destinations);
  assert.deepEqual(mobile.map(({ label }) => label), labels);
  assert.deepEqual(mobile.map(({ href, label }) => ({ href, label })), links(navigation.renderMainNavigation("transactions")).map(({ href, label }) => ({ href, label })));
});
