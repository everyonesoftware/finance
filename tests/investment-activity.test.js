import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTransactionImport } from '../server/transaction-import.ts';
import { importCandidates } from '../server/import-candidates.ts';
import { fidelityHeader, fidelityRows, fidelityHistory } from './fixtures/fidelity-history.js';

const parse = content => parseTransactionImport('history.csv', content, 'USD');

test('Fidelity history preserves security data and conservative source-based activity classification', () => {
  const result = parse(fidelityHistory);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.transactions.map(tx => tx.investmentActivity?.kind), ['trade', 'income', 'income', 'transfer', 'transfer', 'trade', 'trade', 'transfer']);
  assert.deepEqual(result.transactions[0].investmentActivity, { kind: 'trade', symbol: 'DEMO', quantity: 2.5, price: 10, distribution: 'reinvested' });
  assert.equal(result.transactions[5].investmentActivity.quantity, -20);
  assert.equal(result.transactions[1].investmentActivity.distribution, 'unknown', '(Cash) describes account type, not distribution treatment');
  assert.equal(result.transactions[2].investmentActivity.price, null, 'missing price is unknown, not zero');
  assert.match(result.notes.join(' '), /security details/i);
  assert.doesNotMatch(result.notes.join(' '), /share quantities.*not imported/i);
});

test('generic CSV and custom cash mappings never invent investment metadata', () => {
  const generic = parseTransactionImport('generic.csv', 'Date,Description,Amount\n2026-10-30,DIVIDEND RECEIVED DEMO,25', 'USD');
  assert.equal(generic.transactions[0].investmentActivity, undefined);
  const custom = parseTransactionImport('history.csv', fidelityHeader + '\n' + fidelityRows[1], 'USD', { dateColumn: 0, nameColumn: 3, amountColumn: 10, dateFormat: 'mdy', amountConvention: 'outflow-positive' });
  assert.equal(custom.transactions[0].investmentActivity, undefined);
});

test('Fidelity fractional share and price precision is preserved without deriving valuations', () => {
  const row = fidelityRows[0].replace('Cash,10,2.5,', 'Cash,10.12345678,2.12345678,');
  const tx = parse(fidelityHeader + '\n' + row).transactions[0];
  assert.equal(tx.investmentActivity.quantity, 2.12345678);
  assert.equal(tx.investmentActivity.price, 10.12345678);
  assert.equal(tx.amount, 25, 'source cash amount remains authoritative');
  assert.equal(tx.marketValue, undefined);
  assert.equal(tx.costBasis, undefined);
});

test('malformed Fidelity security numbers fail the row instead of silently dropping or rewriting them', () => {
  for (const raw of ['NaN', 'Infinity', '1e3', '1.2oops', '1.123456789', '1000000000001', '12,34']) {
    const row = fidelityRows[0].replace('Cash,10,2.5,', `Cash,10,"${raw}",`);
    assert.match(parse(fidelityHeader + '\n' + row).errors.join(' '), /quantity/i, raw);
  }
  const negative = fidelityRows[0].replace('Cash,10,2.5,', 'Cash,-1,2.5,');
  assert.match(parse(fidelityHeader + '\n' + negative).errors.join(' '), /price/i);
});

test('unknown Fidelity actions are explicit other, fees classify without treating purchases as spending', () => {
  const make = action => parse(fidelityHeader + '\n' + fidelityRows[0].replace('REINVESTMENT EXAMPLE FUND (DEMO) (Cash)', action)).transactions[0].investmentActivity;
  assert.equal(make('SERVICE FEE (Cash)').kind, 'fee');
  assert.equal(make('UNRECOGNIZED ACTION (Cash)').kind, 'other');
  assert.equal(make('NOT A DIVIDEND RECEIVED').kind, 'other');
});

test('richer metadata preserves cash import identities for previously imported Fidelity files', () => {
  const transactions = parse(fidelityHistory).transactions;
  const legacy = transactions.map(({ investmentActivity, ...rest }) => rest);
  assert.deepEqual(importCandidates(transactions, 'owner', { id: 'account' }).map(({ id, fingerprint }) => ({ id, fingerprint })), importCandidates(legacy, 'owner', { id: 'account' }).map(({ id, fingerprint }) => ({ id, fingerprint })));
});
