import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { renderDashboard } from "../src/dashboard.ts";
import { renderTransactionsPage } from "../src/transactions-page.ts";
import { renderBankAccountsPage, renderBankAccountDetailPage, renderConnectionsPage } from "../src/bank_accounts.ts";

const user = { displayName: "Test User", username: "test" };
for (const [name, render] of Object.entries({
  Overview: renderDashboard,
  Transactions: renderTransactionsPage,
  Accounts: renderBankAccountsPage,
  "Account details": renderBankAccountDetailPage,
  "Real Estate": renderConnectionsPage,
})) {
  test(`${name} omits decorative page footers without removing navigation`, () => {
    const html = render(user);
    assert.doesNotMatch(html, /class="page-footer"|Your finances, in focus\.|Finance · Personal finance/);
    assert.match(html, /aria-label="Mobile navigation"/);
    assert.match(html, /<main\b/);
  });
}

test("login page omits the decorative landing footer", () => {
  const source = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /<footer class="landing-footer"/);
});
