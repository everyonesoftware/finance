import assert from 'node:assert/strict';
import test from 'node:test';
import { renderAccounts } from '../src/bank_accounts.ts';

const account = { id: 'checking', itemId: 'manual-checking', institutionName: 'Ally', name: 'Dan Spending', officialName: null, type: 'depository', subtype: 'checking', mask: '9951', currentBalance: 100, availableBalance: null, currencyCode: 'USD', updatedAt: '2026-11-01T00:00:00Z', source: 'manual', canImport: true };
const cards = html => [...html.matchAll(/<section class="institution-card"[\s\S]*?<\/section>/g)].map(match => match[0]);

test('accounts from the same bank share one card despite separate item IDs, casing and surrounding whitespace', () => {
  const accounts = [account,
    { ...account, id: 'other', itemId: 'other-item', institutionName: 'Other Bank', name: 'Other checking' },
    { ...account, id: 'savings', itemId: 'manual-savings', institutionName: ' ally ', name: 'Dan Savings', subtype: 'savings', mask: '1257', currentBalance: 200, updatedAt: '2026-11-03T00:00:00Z' },
    { ...account, id: 'ebay', itemId: 'manual-ebay', institutionName: 'ALLY', name: 'EBay', mask: '4753' }];
  const before = structuredClone(accounts);
  const groups = cards(renderAccounts(accounts));
  assert.equal(groups.length, 2);
  assert.match(groups[0], /<h2>Ally<\/h2>/);
  assert.match(groups[0], /MANUAL ACCOUNTS/);
  assert.match(groups[0], /3 accounts/);
  for (const entry of [accounts[0], accounts[2], accounts[3]]) {
    assert.ok(groups[0].includes(`href="/accounts/${entry.id}"`));
    assert.ok(groups[0].includes(entry.name));
    assert.ok(groups[0].includes(`•••• ${entry.mask}`));
  }
  assert.match(groups[0], /\$100\.00/);
  assert.match(groups[0], /\$200\.00/);
  const latest = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(accounts[2].updatedAt));
  assert.ok(groups[0].includes(`Updated ${latest}`));
  assert.match(groups[1], /Other checking/);
  assert.doesNotMatch(groups[0], /Other checking/);
  assert.deepEqual(accounts, before);
});

test('bank grouping preserves mixed sources, saved retrieval times, escaping and singular labels', () => {
  const saved = { ...account, id: 'saved/id', itemId: 'saved-item', source: 'saved', canImport: false, name: '<Saved>', institutionName: '<Bank>', lastRetrievedAt: '2026-11-05T00:00:00Z' };
  const mixed = cards(renderAccounts([{ ...account, institutionName: '<Bank>' }, saved]));
  assert.equal(mixed.length, 1);
  assert.match(mixed[0], /<h2>&lt;Bank&gt;<\/h2>/);
  assert.match(mixed[0], /<p class="eyebrow">ACCOUNTS<\/p>/);
  assert.match(mixed[0], /&lt;Saved&gt;/);
  assert.match(mixed[0], /href="\/accounts\/saved%2Fid"/);
  const single = renderAccounts([account]);
  assert.match(single, /MANUAL ACCOUNT<\/p>/);
  assert.match(single, /1 account<\/span>/);
  const savedHtml = renderAccounts([saved]);
  const latest = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(saved.lastRetrievedAt));
  assert.ok(savedHtml.includes(`Last retrieved ${latest}`));
  assert.match(savedHtml, /SAVED INSTITUTION/);
  assert.match(renderAccounts([]), /No accounts yet/);
});
