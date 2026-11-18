import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("all page and authentication transitions use the SPA without PWA update behavior", async () => {
  const main = await readFile(new URL("../src/main.ts", import.meta.url), "utf8");
  assert.match(main, /createClientRouter\(/);
  assert.doesNotMatch(main, /window\.location\.(?:assign|replace)\(/);
  assert.match(main, /pageLifetime\.abort\(\)/);
  assert.match(main, /initializeTransactionsPage\(signal\)/);
  assert.match(main, /initializeAccountDetailPage\(accountId, signal\)/);
  assert.match(main, /initializeBankAccountsPage\(signal\)/);
  assert.doesNotMatch(main, /appUpdates|serviceWorker|id="(?:check|reload|later)-update"/);
});
