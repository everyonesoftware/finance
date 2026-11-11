import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { renderTransactionsPage } from '../src/transactions-page.ts';
import * as page from '../src/transactions-page.ts';
import { renderTransactionGroups } from '../src/transaction-list.ts';

const user = { displayName: 'Tester', username: 'tester' };

test('crossing the mobile breakpoint moves the same fields without resetting list or filter state', () => {
  assert.equal(typeof page.initializeResponsiveTransactions, 'function');
  class Node {
    isConnected = true; children = []; parentElement = null; open = false; value = 'preserved';
    classList = { toggle() {} }; attributes = {}; handlers = {};
    append(...nodes) { for (const node of nodes) { if (node.parentElement) node.parentElement.children = node.parentElement.children.filter(child => child !== node); node.parentElement = this; this.children.push(node); } }
    addEventListener(name, handler) { this.handlers[name] = handler; }
    setAttribute(name, value) { this.attributes[name] = value; }
    close() { this.open = false; this.closed = true; }
  }
  const nodes = Object.fromEntries([...renderTransactionsPage(user).matchAll(/id="([^"]+)"/g)].map(match => ['#' + match[1], new Node()]));
  const heading = new Node(), actions = new Node();
  const root = Object.assign(new Node(), { querySelector: selector => selector === '.transactions-page-heading' ? heading : selector === '.transaction-heading-actions' ? actions : nodes[selector] ?? null });
  const media = { matches: false, addEventListener(_, fn) { this.change = fn; }, removeEventListener() {} };
  page.initializeResponsiveTransactions(root, media);
  const fields = nodes['#transaction-account-fields'], amount = nodes['#transaction-amount-fields'], sort = nodes['#transaction-sort-fields'];
  assert.equal(heading.parentElement, nodes['#transaction-desktop-heading']);
  assert.equal(fields.parentElement, nodes['#accounts-filter-popover']);
  assert.equal(amount.parentElement, nodes['#amount-filter-popover']);
  assert.equal(sort.parentElement, nodes['#transaction-desktop-sort']);
  assert.equal(nodes['#open-batch-import'].parentElement, nodes['#transaction-desktop-import']);
  assert.equal(nodes['#all-transactions-count'].parentElement, nodes['#transaction-desktop-toolbar']);
  media.matches = true; media.change();
  assert.equal(heading.parentElement, nodes['#transaction-mobile-heading']);
  assert.equal(fields.parentElement, nodes['#transaction-filter-sheet-body']);
  assert.equal(amount.parentElement, nodes['#transaction-filter-sheet-body']);
  assert.equal(sort.parentElement, nodes['#transaction-sort-sheet-body']);
  assert.equal(nodes['#open-batch-import'].parentElement, actions);
  nodes['#transaction-filters-dialog'].open = true;
  media.matches = false; media.change();
  assert.equal(nodes['#transaction-filters-dialog'].open, false);
  assert.equal(fields.parentElement, nodes['#accounts-filter-popover']);
  assert.equal(fields.value, 'preserved');
  assert.equal(nodes['#all-transactions-list'].value, 'preserved');
});

test('Transactions retains the desktop toolbar while sharing a single set of controls with mobile sheets', () => {
  const html = renderTransactionsPage(user);
  assert.match(html, /id="transaction-desktop-heading"/);
  assert.match(html, /id="transaction-desktop-toolbar"/);
  assert.match(html, /id="accounts-filter-trigger"[^>]*aria-controls="accounts-filter-popover"/);
  assert.match(html, /id="amount-filter-trigger"[^>]*aria-controls="amount-filter-popover"/);
  assert.match(html, /id="transaction-desktop-sort"/);
  assert.match(html, /id="transaction-desktop-import"/);
  assert.match(html, /class="transaction-import-label">Import Transactions<\/span>/);
  assert.match(html, /Search saved activity across your accounts/);
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length, 'Responsive layouts must not duplicate form IDs');
  for (const id of ['account-options', 'transaction-sort-order', 'minimum-transaction-amount', 'maximum-transaction-amount', 'open-batch-import', 'all-transactions-list']) {
    assert.equal(ids.filter(value => value === id).length, 1);
  }
});

test('responsive activity rows retain the legacy desktop date and pending text without duplicating rows', () => {
  const groups = [{ type: 'single', transactions: [{ name: 'Coffee', amount: 5, date: '2026-11-10', pending: true }] }];
  const html = renderTransactionGroups(groups, [], { activityStyle: true, groupByDate: true, responsiveActivity: true });
  assert.match(html, /class="transaction-desktop-date">2026-11-10 · Pending<\/span>/);
  assert.match(html, /class="transaction-pending">Pending<\/span>/);
  assert.match(html, /class="transaction-avatar"/);
  assert.equal((html.match(/class="account-row transaction-row"/g) ?? []).length, 1);
  const amountSorted = renderTransactionGroups(groups, [], { activityStyle: true, responsiveActivity: true });
  assert.match(amountSorted, /class="transaction-mobile-date">2026-11-10<\/span>/);
});

test('the mobile activity redesign is confined to the mobile breakpoint', async () => {
  const css = await readFile(new URL('../src/style.css', import.meta.url), 'utf8');
  const marker = css.indexOf('/* Transactions: everyday activity.');
  const activity = css.slice(marker);
  const start = activity.indexOf('@media (max-width: 800px)');
  assert.ok(start >= 0);
  const desktop = activity.slice(0, start);
  assert.doesNotMatch(desktop, /min-height:\s*69px|grid-template-columns:\s*34px|font-size:\s*14px/);
  assert.match(desktop, /\.transaction-heading-actions[\s\S]*display:\s*none/);
  assert.match(activity.slice(start), /grid-template-columns:\s*34px minmax\(0, 1fr\) auto/);
});
