import test from 'node:test';
import assert from 'node:assert/strict';
import * as transactionList from '../src/transaction-list.ts';
import { findReferencedAccount, findFidelityAchAccountMention } from '../src/account-transaction-utils.ts';

// Frozen quadratic matching oracle: deliberately independent of the candidate index.
function referenceGroups(transactions, accounts) {
  const field = (t, key) => typeof t[key] === 'string' && t[key].length ? t[key] : null;
  const amount = t => typeof t.amount === 'number' && Number.isFinite(t.amount) ? t.amount : null;
  const currency = t => field(t, 'iso_currency_code') ?? field(t, 'unofficial_currency_code');
  const direction = name => {
    if (!/\btransfer\b|\bxfer\b/i.test(name)) return null;
    const to = /\bto\b/i.test(name), from = /\bfrom\b/i.test(name);
    return to === from ? null : to ? 'to' : 'from';
  };
  const ordinal = date => /^\d{4}-\d{2}-\d{2}$/.test(date ?? '') ? Date.parse(`${date}T00:00:00.000Z`) / 86400000 : NaN;
  const byId = new Map(accounts.filter(a => a.providerAccountId).map(a => [a.providerAccountId, a]));
  const pair = (a, b) => {
    const ai = field(a, 'account_id'), bi = field(b, 'account_id');
    const an = field(a, 'name'), bn = field(b, 'name');
    const aa = amount(a), ba = amount(b);
    if (!ai || !bi || ai === bi || !an || !bn || aa === null || ba === null || aa === 0 || ba === 0) return null;
    if (Math.sign(aa) === Math.sign(ba) || Math.round(Math.abs(aa) * 100) !== Math.round(Math.abs(ba) * 100)) return null;
    if (!currency(a) || currency(a) !== currency(b)) return null;
    const ad = direction(an), bd = direction(bn);
    if (!ad || !bd || ad === bd) return null;
    const ao = ordinal(field(a, 'date')), bo = ordinal(field(b, 'date'));
    if (!Number.isFinite(ao) || !Number.isFinite(bo) || Math.abs(ao - bo) > 3) return null;
    if (!byId.has(ai) || !byId.has(bi)) return null;
    if (findReferencedAccount(an, accounts)?.providerAccountId !== bi || findReferencedAccount(bn, accounts)?.providerAccountId !== ai) return null;
    const outgoing = ad === 'to' ? a : b, incoming = ad === 'from' ? a : b;
    const fromAccount = byId.get(field(outgoing, 'account_id'));
    const toAccount = findReferencedAccount(field(outgoing, 'name'), accounts);
    if (!fromAccount || !toAccount || fromAccount.id === toAccount.id || field(incoming, 'account_id') !== toAccount.providerAccountId) return null;
    return { fromAccount, toAccount };
  };
  const groups = [], consumed = new Set();
  for (let i = 0; i < transactions.length; i++) {
    const t = transactions[i];
    if (consumed.has(i) || !t) continue;
    let matched = false;
    for (let j = i + 1; j < transactions.length; j++) {
      if (consumed.has(j) || !transactions[j]) continue;
      const linked = pair(t, transactions[j]);
      if (!linked) continue;
      consumed.add(j);
      groups.push({ type: 'transfer', transactions: [t, transactions[j]], ...linked });
      matched = true;
      break;
    }
    if (matched) continue;
    const name = field(t, 'name'), value = amount(t), receiver = byId.get(field(t, 'account_id'));
    const source = name && /\bFID\s+BKG\s+SVC\s+LLC\s+ACH\b/i.test(name) && value !== null && value < 0 && receiver?.type === 'depository'
      ? findFidelityAchAccountMention(name, accounts)?.account : null;
    groups.push(source && source.id !== receiver.id
      ? { type: 'transfer', transactions: [t], fromAccount: source, toAccount: receiver }
      : { type: 'single', transactions: [t] });
  }
  return groups;
}

const accounts = [
  { id: 'checking', providerAccountId: 'checking', institutionName: 'Bank', name: 'Checking', type: 'depository', mask: '1257' },
  { id: 'savings', providerAccountId: 'savings', institutionName: 'Bank', name: 'Savings', type: 'depository', mask: '4321' },
  { id: 'fidelity', providerAccountId: 'fidelity', institutionName: 'Fidelity', name: 'Brokerage', type: 'investment', mask: '9876' },
];

function transaction(id, incoming = false, overrides = {}) {
  return {
    transaction_id: id,
    account_id: incoming ? 'savings' : 'checking',
    name: incoming ? 'Transfer from Checking account 1257' : 'Transfer to Savings account 4321',
    amount: incoming ? -50 : 50,
    date: '2026-10-29',
    iso_currency_code: 'USD',
    ...overrides,
  };
}

test('candidate discovery has a linear record-read bound for unrelated transfers', () => {
  for (const dimension of ['direction', 'amount', 'currency', 'date']) {
    for (const size of [128, 512]) {
      let reads = 0;
      const records = Array.from({ length: size }, (_, i) => {
        const incoming = dimension === 'direction' ? false : i % 2 === 1;
        const overrides = dimension === 'amount' ? { amount: (incoming ? -1 : 1) * (i + 1) }
          : dimension === 'currency' ? { iso_currency_code: `currency-${i}` }
          : dimension === 'date' ? { date: new Date(Date.UTC(2000, 0, 1 + i * 10)).toISOString().slice(0, 10) } : {};
        const record = transaction(String(i), incoming, overrides);
        return new Proxy(record, { get(target, key, receiver) { reads++; return Reflect.get(target, key, receiver); } });
      });
      assert.equal(transactionList.groupInternalTransfers(records, accounts).length, size);
      assert.ok(reads <= size * 40, `${dimension}: ${reads} record reads exceeds ${size * 40}`);
    }
  }
});

test('indexed grouping preserves quadratic first-match behavior across mixed inputs', () => {
  let state = 0x12345678;
  const random = n => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return (state >>> 8) % n; };
  const variants = [
    {}, { amount: 50.004 }, { amount: 0 }, { amount: NaN }, { amount: Infinity },
    { date: '2026-11-01' }, { date: '2026-11-02' }, { date: 'bad' }, { date: '2026-02-30' },
    { iso_currency_code: null, unofficial_currency_code: 'USD' }, { iso_currency_code: 'EUR' },
    { name: 'Transfer to and from account 4321' }, { name: 'Groceries' },
    { account_id: 'missing' }, { name: 'Transfer to account 9999' },
    { account_id: 'checking', name: 'X123459876 CREDIT FID BKG SVC LLC ACH', amount: -50 },
  ];
  const firstMatch = [transaction('first'), transaction('later-date', true, { date: '2026-11-01' }), transaction('same-date', true), transaction('second')];
  const result = transactionList.groupInternalTransfers(firstMatch, accounts);
  assert.deepEqual(result[0].transactions.map(t => t.transaction_id), ['first', 'later-date']);
  assert.deepEqual(result, referenceGroups(firstMatch, accounts));
  for (let run = 0; run < 80; run++) {
    const records = Array.from({ length: 32 }, (_, i) => transaction(`${run}-${i}`, random(2) === 1, variants[random(variants.length)]));
    records.splice(random(records.length), 0, undefined);
    const before = structuredClone(records);
    assert.deepEqual(transactionList.groupInternalTransfers(records, accounts), referenceGroups(records, accounts), `seeded run ${run}`);
    assert.deepEqual(records, before);
  }
});

test('pre-grouped renderer preserves supplied groups instead of grouping again', () => {
  assert.equal(typeof transactionList.renderTransactionGroups, 'function');
  const outgoing = transaction('out');
  const incoming = transaction('in', true);
  const groups = [
    { type: 'single', transactions: [outgoing] },
    { type: 'single', transactions: [incoming] },
  ];
  const singlesHtml = transactionList.renderTransactionGroups(groups, accounts, { showAccount: true });
  assert.doesNotMatch(singlesHtml, /transaction-transfer-pair/);
  assert.match(singlesHtml, /transaction-account-label/);
  assert.match(singlesHtml, /Transfer to/);
  const paired = transactionList.groupInternalTransfers([outgoing, incoming], accounts);
  assert.equal(transactionList.renderTransactionGroups(paired, accounts, { showAccount: true }),
    transactionList.renderTransactionList([outgoing, incoming], accounts, { showAccount: true }));
  assert.match(transactionList.renderTransactionGroups(paired, accounts), /transaction-transfer-pair/);
  assert.equal(transactionList.renderTransactionGroups([], accounts), 'No saved transactions are available.');
});
