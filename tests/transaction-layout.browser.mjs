import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'vite';
import { chromium } from 'playwright';

// Browser-only financial fixtures; never connect to the API or user storage.
const accounts = [
  { id: 'checking', providerAccountId: 'checking', name: 'Checking', institutionName: 'Example', type: 'depository', subtype: 'checking' },
  { id: 'card', providerAccountId: 'card', name: 'Rewards Card', institutionName: 'CapitalOne', type: 'credit', subtype: 'credit card' },
];
const transactions = [
  ...Array.from({ length: 12 }, (_, index) => ({ transaction_id: `reward-${index}`, account_id: 'card', name: 'CREDIT-TRAVEL REWARD CREDIT-TRAVEL REWARD', amount: -5, date: `2026-11-${String(12 - index).padStart(2, '0')}`, iso_currency_code: 'USD' })),
  { transaction_id: 'coffee', account_id: 'checking', name: 'Coffee', amount: 5, date: '2026-10-31', iso_currency_code: 'USD' },
];

test('transaction rails scroll behind the full search gutter and mobile rows match group backgrounds', async t => {
  const server = await createServer({ configFile: false, server: { host: '127.0.0.1', port: 0, hmr: false }, plugins: [{
    name: 'transaction-layout-fixture',
    configureServer(server) {
      server.middlewares.use('/__transaction-layout', (_request, response) => {
        response.setHeader('Content-Type', 'text/html');
        response.end('<!doctype html><html><head><link rel="stylesheet" href="/src/style.css"></head><body></body></html>');
      });
    },
  }] });
  await server.listen();
  t.after(() => server.close());
  const browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', route => route.fulfill({ json: { accounts, transactions, configured: false } }));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__transaction-layout`);
  await page.evaluate(async () => {
    const { renderTransactionsPage, initializeTransactionsPage } = await import('/src/transactions-page.ts');
    document.body.innerHTML = renderTransactionsPage({ displayName: 'Preview', username: 'preview' });
    await initializeTransactionsPage();
  });

  await t.test('mobile ordinary rows have the same white surface as collapsed groups', async () => {
    for (const width of [320, 390, 800]) {
      await page.setViewportSize({ width, height: 740 });
      const colors = await page.evaluate(() => {
        const background = element => {
          while (element) {
            const color = getComputedStyle(element).backgroundColor;
            if (color !== 'rgba(0, 0, 0, 0)') return color;
            element = element.parentElement;
          }
        };
        return {
          ordinary: background(document.querySelector('#all-transactions-list > .transaction-row')),
          group: background(document.querySelector('.transaction-transfer-pair summary')),
        };
      });
      assert.equal(colors.ordinary, colors.group, `background mismatch at ${width}px`);
      assert.equal(colors.group, 'rgb(255, 255, 255)');
    }
  });

  await t.test('search background occludes rails as they reach the sticky search area', async () => {
    for (const width of [320, 390, 800, 801, 1440]) {
      await page.setViewportSize({ width, height: 740 });
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.evaluate(() => {
        const element = document.querySelector('.transactions-sticky-controls');
        const controls = element.getBoundingClientRect();
        const group = document.querySelector('.transaction-transfer-pair').getBoundingClientRect();
        window.scrollBy(0, group.top - parseFloat(getComputedStyle(element).top) - controls.height + 30);
      });
      const bounds = await page.evaluate(() => {
        const controls = document.querySelector('.transactions-sticky-controls').getBoundingClientRect();
        const group = document.querySelector('.transaction-transfer-pair');
        const box = group.getBoundingClientRect();
        const rail = getComputedStyle(group, '::before');
        const x = box.left + parseFloat(rail.left) + parseFloat(rail.width) / 2;
        const y = controls.bottom - 3;
        const top = document.elementFromPoint(x, y);
        return {
          covered: Boolean(top?.closest('.transactions-sticky-controls')),
          railCrossesSearch: box.top + parseFloat(rail.top) < y && box.bottom > y,
          horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
        };
      });
      assert.equal(bounds.railCrossesSearch, true, `fixture must put the rail behind search at ${width}px`);
      assert.equal(bounds.covered, true, `rail gutter must be covered at ${width}px`);
      assert.equal(bounds.horizontalOverflow, false, `no horizontal overflow at ${width}px`);
    }
  });

  await t.test('expanded details retain their gray surface and row identity across breakpoints', async () => {
    await page.setViewportSize({ width: 390, height: 740 });
    await page.evaluate(() => {
      window.scrollTo(0, 0);
      window.layoutGroup = document.querySelector('.transaction-transfer-pair');
      window.layoutGroup.open = true;
    });
    for (const width of [390, 1440, 390]) {
      await page.setViewportSize({ width, height: 740 });
      assert.deepEqual(await page.evaluate(() => ({
        same: window.layoutGroup === document.querySelector('.transaction-transfer-pair'),
        open: window.layoutGroup.open,
        background: getComputedStyle(window.layoutGroup.querySelector('.transfer-pair-rows')).backgroundColor,
      })), { same: true, open: true, background: 'rgb(245, 245, 244)' });
    }
    if (process.env.FINANCE_LAYOUT_SCREENSHOT) await page.screenshot({ path: process.env.FINANCE_LAYOUT_SCREENSHOT });
  });
  assert.deepEqual(errors, []);
});
