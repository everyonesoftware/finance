// Synthetic-only benchmark: node --import tsx scripts/benchmark-transactions.mjs
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { groupInternalTransfers, renderTransactionGroups } from '../src/transaction-list.ts';
import { filterAndSortTransactionGroups } from '../src/transaction-filters.ts';

const accounts = [
  { id: 'a', providerAccountId: 'a', name: 'Checking', institutionName: 'Example Bank', type: 'depository' },
  { id: 'b', providerAccountId: 'b', name: 'Savings', institutionName: 'Example Bank', type: 'depository' },
];
const filters = { includeAccountIds: ['a', 'b'], excludeAccountIds: [], minimumAmount: -Infinity, maximumAmount: Infinity, sort: 'date-desc' };
const median = values => Number([...values].sort((a, b) => a - b)[Math.floor(values.length / 2)].toFixed(2));

for (const size of [3000, 10000, 50000]) {
  const transactions = Array.from({ length: size }, (_, index) => ({
    transaction_id: String(index), account_id: index % 2 ? 'a' : 'b',
    name: 'Synthetic purchase', amount: 12.34, date: '2026-01-01', iso_currency_code: 'USD',
  }));
  const samples = { groupingMs: [], filterSortMs: [], firstPageHtmlMs: [] };
  let htmlBytes = 0;
  for (let run = 0; run < 5; run++) {
    let start = performance.now();
    const groups = groupInternalTransfers(transactions, accounts);
    const groupingMs = performance.now() - start;
    start = performance.now();
    const filtered = filterAndSortTransactionGroups(groups, accounts, filters);
    const filterSortMs = performance.now() - start;
    start = performance.now();
    const html = renderTransactionGroups(filtered.slice(0, 50), accounts, { showAccount: true });
    const firstPageHtmlMs = performance.now() - start;
    assert.equal(groups.length, size);
    assert.equal((html.match(/class="account-row transaction-row"/g) ?? []).length, 50);
    htmlBytes = Buffer.byteLength(html);
    if (run > 0) {
      samples.groupingMs.push(groupingMs);
      samples.filterSortMs.push(filterSortMs);
      samples.firstPageHtmlMs.push(firstPageHtmlMs);
    }
  }
  console.log(JSON.stringify({ transactions: size, ...Object.fromEntries(Object.entries(samples).map(([key, values]) => [key, median(values)])), htmlBytes }));
}
