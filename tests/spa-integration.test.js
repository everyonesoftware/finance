import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("all page and authentication transitions are wired to the SPA and update checks use the app lifecycle", async () => {
  const main = await readFile(new URL("../src/main.ts", import.meta.url), "utf8");
  assert.match(main, /createClientRouter\(/);
  assert.doesNotMatch(main, /window\.location\.(?:assign|replace)\(/);
  assert.match(main, /pageLifetime\.abort\(\)/);
  assert.match(main, /initializeTransactionsPage\(signal\)/);
  assert.match(main, /initializeAccountDetailPage\(accountId, signal\)/);
  assert.match(main, /initializeBankAccountsPage\(signal\)/);
  assert.match(main, /appUpdates\.start\(\)/);
  assert.match(main, /appUpdates\.subscribe\(/);
  assert.match(main, /signal\.addEventListener\("abort", unsubscribe/);
  assert.match(main, /id="check-update"/);
  assert.match(main, /id="reload-update"[^>]*hidden/);
  assert.match(main, /id="later-update"[^>]*hidden/);
});
