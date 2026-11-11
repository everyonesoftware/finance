import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

test('shared transaction groups use ordinary amounts, rail-to-edge details and row separators', async () => {
  const css = await readFile(new URL('../src/style.css', import.meta.url), 'utf8');
  const shared = css.slice(0, css.indexOf('@media'));
  const rule = selector => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return [...shared.matchAll(new RegExp('(?:^|\\n)' + escaped + '\\s*\\{([^}]+)\\}', 'g'))]
      .map(match => match[1]).join('\n');
  };
  // Both ordinary and summary amounts use one declaration; children inherit it.
  assert.match(shared, /\.transaction-row > b,\s*\.transfer-pair-amount\s*\{[^}]*font-size:\s*11px;[^}]*font-weight:\s*700;/);
  const childAmount = rule('.transfer-pair-rows .transaction-row > b');
  assert.doesNotMatch(childAmount, /font-size:|font-weight:|font-variant-numeric:/);
  assert.doesNotMatch(rule('.transfer-pair-amount'), /font-variant-numeric:\s*tabular-nums/);
  const details = rule('.transfer-pair-rows');
  assert.match(details, /margin-left:\s*calc\(var\(--transaction-group-copy-offset, 0px\) - 7px\)/);
  assert.match(details, /margin-right:\s*calc\(-1 \* var\(--transaction-list-right-gutter, 20px\)\)/);
  assert.match(details, /padding-right:\s*var\(--transaction-list-right-gutter, 20px\)/);
  assert.match(details, /padding-left:\s*calc\(var\(--transaction-child-copy-offset, 13px\) - var\(--transaction-group-copy-offset, 0px\) \+ 7px\)/);
  assert.match(rule('.transaction-transfer-pair:not(:last-child)'), /border-bottom:\s*1px solid #f0f1ee/);
  // Explicit container gutters must track the real responsive padding.
  assert.match(css, /\.panel\s*\{[^}]*--transaction-list-right-gutter:\s*17px/);
  assert.match(css, /\.account-detail-transactions\s*\{[^}]*--transaction-list-right-gutter:\s*16px/);
  assert.match(css, /\.transactions-content \.transactions-results\s*\{[^}]*--transaction-list-right-gutter:\s*0px/);
  assert.match(css, /\.transactions-content \.transaction-transfer-pair\s*\{[^}]*--transaction-group-copy-offset:\s*0px/);
  assert.match(css, /\.transactions-content \.transfer-pair-rows\s*\{[^}]*--transaction-child-copy-offset:\s*13px/);
});
