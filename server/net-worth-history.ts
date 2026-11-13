import type Database from "better-sqlite3";
import { decryptBankValue, encryptBankValue } from "./bank-crypto.js";
import { validBalanceDate, validMoney } from "./account-balances.js";
import { observeNetWorth, summarizeAccountBalances, type BalanceSummary, type NetWorthSummary } from "./net-worth.js";

const dayMs = 86_400_000;
const cacheVersion = 1;
type Account = Record<string, unknown>;
type Point = { date: string; total: number };
interface HistoryCache {
  version: number;
  date: string;
  summary: BalanceSummary;
  points: Point[];
  eligibleAccountCount: number;
  unsupportedAccountCount: number;
}
interface AccountHistory { start: string; currentCents: bigint; dailyOutflow: Map<string, bigint> }

function accountHistory(account: Account, transactions: Account[], now: Date): AccountHistory | null {
  const ref = account.balanceReference as Record<string, unknown> | undefined;
  if (account.source !== "manual" || !["depository", "credit", "loan"].includes(String(account.type)) ||
    !ref || ref.verified !== true || !validMoney(ref.amount) || !validBalanceDate(ref.date, now) || !validMoney(account.currentBalance)) return null;
  const liability = account.type === "credit" || account.type === "loan";
  let expected = BigInt(Math.round(ref.amount * 100)) * (liability ? -1n : 1n);
  let start = ref.date;
  const dailyOutflow = new Map<string, bigint>();
  for (const tx of transactions) {
    if (tx.pending === true) continue;
    // A malformed, foreign-currency or future posted row is not reliable coverage.
    if (!validBalanceDate(tx.date, now) || !validMoney(tx.amount) ||
      tx.iso_currency_code !== undefined && tx.iso_currency_code !== "USD") return null;
    const amount = BigInt(Math.round(tx.amount * 100));
    if (tx.date < start) start = tx.date;
    dailyOutflow.set(tx.date, (dailyOutflow.get(tx.date) ?? 0n) + amount);
    if (tx.date > ref.date) expected -= amount;
  }
  const currentCents = BigInt(Math.round(account.currentBalance * 100)) * (liability ? -1n : 1n);
  if (expected !== currentCents) return null;
  return { start, currentCents, dailyOutflow };
}

function reconstruct(accounts: Account[], summary: BalanceSummary, loadTransactions: (account: Account) => Account[], now: Date): Pick<HistoryCache, "points" | "eligibleAccountCount" | "unsupportedAccountCount"> {
  const histories: AccountHistory[] = [];
  let unsupportedAccountCount = 0;
  for (const account of accounts) {
    if (account.currencyCode !== "USD") continue;
    // Do not decrypt transactions for accounts we already know cannot be reconstructed.
    const ref = account.balanceReference as Record<string, unknown> | undefined;
    const canReconstruct = account.source === "manual" && ["depository", "credit", "loan"].includes(String(account.type)) && ref?.verified === true;
    const history = canReconstruct ? accountHistory(account, loadTransactions(account), now) : null;
    if (history) histories.push(history);
    else unsupportedAccountCount++;
  }
  const result = { points: [] as Point[], eligibleAccountCount: histories.length, unsupportedAccountCount };
  // Never silently substitute a partial-account trend for the displayed net worth.
  if (!histories.length || unsupportedAccountCount || summary.total === null) return result;
  const end = Date.parse(now.toISOString().slice(0, 10));
  const starts = histories.map(history => Date.parse(history.start));
  const start = Math.max(end - 364 * dayMs, ...starts);
  let total = histories.reduce((sum, history) => sum + history.currentCents, 0n);
  const dailyOutflow = new Map<string, bigint>();
  for (const history of histories) {
    for (const [date, amount] of history.dailyOutflow) dailyOutflow.set(date, (dailyOutflow.get(date) ?? 0n) + amount);
  }
  for (let day = end; day >= start; day -= dayMs) {
    if (total > BigInt(Number.MAX_SAFE_INTEGER) || total < BigInt(Number.MIN_SAFE_INTEGER)) throw Error("Historical total exceeds safe cent precision.");
    const date = new Date(day).toISOString().slice(0, 10);
    const dollars = Number(total) / 100;
    if (BigInt(Math.round(dollars * 100)) !== total) throw Error("Historical total cannot round-trip in cents.");
    result.points.push({ date, total: dollars });
    // Reversing today's posted outflows gives the previous end-of-day balance.
    total += dailyOutflow.get(date) ?? 0n;
  }
  result.points.reverse();
  return result;
}

function readCache(encrypted: string, key: Buffer, date: string, now: Date): HistoryCache | null {
  try {
    const cache = JSON.parse(decryptBankValue(encrypted, key)) as HistoryCache;
    const summary = cache.summary;
    if (cache.version !== cacheVersion || cache.date !== date || !summary || summary.currencyCode !== "USD" ||
      summary.total !== null && (typeof summary.total !== "number" || !Number.isFinite(summary.total)) ||
      ![summary.accountCount, summary.includedAccountCount, summary.excludedAccountCount, summary.unknownBalanceCount, cache.eligibleAccountCount, cache.unsupportedAccountCount]
        .every(count => Number.isSafeInteger(count) && count >= 0) ||
      !Array.isArray(cache.points) || cache.points.length > 365 ||
      !cache.points.every((point, index) => validBalanceDate(point.date, now) && point.date >= new Date(Date.parse(date) - 364 * dayMs).toISOString().slice(0, 10) &&
        typeof point.total === "number" && Number.isFinite(point.total) && (index === 0 || point.date > cache.points[index - 1].date))) return null;
    return cache;
  } catch {
    // This is disposable derived data, not an irreplaceable financial observation.
    return null;
  }
}

export function cachedNetWorth(db: Database.Database, userId: string, key: Buffer, now: Date,
  loadAccounts: () => Account[], loadTransactions: (account: Account) => Account[]): NetWorthSummary {
  // Hold the same write transaction across source reads, cache persistence and
  // today's observation: a concurrent import cannot publish a stale cache.
  return db.transaction(() => {
    const date = now.toISOString().slice(0, 10);
    const row = db.prepare("SELECT encrypted_data FROM net_worth_history_cache WHERE user_id=?").get(userId) as { encrypted_data: string } | undefined;
    let cache = row ? readCache(row.encrypted_data, key, date, now) : null;
    if (!cache) {
      const accounts = loadAccounts();
      const summary = summarizeAccountBalances(accounts);
      cache = { version: cacheVersion, date, summary, ...reconstruct(accounts, summary, loadTransactions, now) };
      db.prepare("INSERT INTO net_worth_history_cache(user_id,encrypted_data) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET encrypted_data=excluded.encrypted_data")
        .run(userId, encryptBankValue(JSON.stringify(cache), key));
    }
    const observed = observeNetWorth(db, userId, cache.summary, key, now);
    const points = new Map<string, NetWorthSummary["points"][number]>(cache.points.map(point => [point.date, { ...point, source: "reconstructed" }]));
    // Real observations win, even after imported history or references are corrected.
    for (const point of observed.points) points.set(point.date, point);
    const merged = [...points.values()].sort((a, b) => a.date.localeCompare(b.date));
    return { ...observed, points: merged, history: {
      reconstructedPointCount: merged.filter(point => point.source === "reconstructed").length,
      eligibleAccountCount: cache.eligibleAccountCount,
      unsupportedAccountCount: cache.unsupportedAccountCount,
    } };
  }).immediate();
}
