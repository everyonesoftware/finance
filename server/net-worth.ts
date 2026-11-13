import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { decryptBankValue, encryptBankValue } from "./bank-crypto.js";

export interface NetWorthSummary {
  currencyCode: "USD";
  total: number | null;
  accountCount: number;
  includedAccountCount: number;
  excludedAccountCount: number;
  unknownBalanceCount: number;
  points: Array<{ date: string; total: number; source?: "reconstructed" }>;
  history?: { reconstructedPointCount: number; eligibleAccountCount: number; unsupportedAccountCount: number };
}
export type BalanceSummary = Omit<NetWorthSummary, "points" | "history">;
interface ObservationRow { id: string; encrypted_data: string; created_at: number }
interface Observation { date: string; total: number }

function readObservation(encrypted: string, key: Buffer): Observation {
  const value: unknown = JSON.parse(decryptBankValue(encrypted, key));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid net-worth observation.");
  const { date, total } = value as Record<string, unknown>;
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date ||
    typeof total !== "number" || !Number.isFinite(total)) throw new Error("Invalid net-worth observation.");
  return { date, total };
}

export function summarizeAccountBalances(accounts: Array<Record<string, unknown>>): BalanceSummary {
  let cents = 0, includedAccountCount = 0, excludedAccountCount = 0, unknownBalanceCount = 0;
  for (const account of accounts) {
    if (account.currencyCode !== "USD") { excludedAccountCount++; continue; }
    if (typeof account.currentBalance !== "number" || !Number.isFinite(account.currentBalance)) { unknownBalanceCount++; continue; }
    const balance = Math.round(account.currentBalance * 100);
    if (!Number.isSafeInteger(balance)) throw new Error("Account balance exceeds safe cent precision.");
    // Signed amounts owed are defined only by the new dated manual model.
    // Do not reinterpret negative archived/undated snapshots during upgrade.
    const debt = account.source === "manual" && account.balanceReference ? -balance : -Math.abs(balance);
    cents += account.type === "credit" || account.type === "loan" ? debt : balance;
    if (!Number.isSafeInteger(cents)) throw new Error("Net worth exceeds safe cent precision.");
    includedAccountCount++;
  }
  const total = includedAccountCount && !unknownBalanceCount ? cents / 100 : null;
  return { currencyCode: "USD", total, accountCount: accounts.length, includedAccountCount, excludedAccountCount, unknownBalanceCount };
}

// Observations remain factual reads, separate from replaceable reconstructed history.
export function observeNetWorth(db: Database.Database, userId: string, summary: BalanceSummary, key: Buffer, now: Date): NetWorthSummary {
  const { total, accountCount, includedAccountCount, excludedAccountCount, unknownBalanceCount } = summary;
  const timestamp = Math.floor(now.getTime() / 1000);
  const date = now.toISOString().slice(0, 10);
  const start = new Date(`${date}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - 364);
  const firstDate = start.toISOString().slice(0, 10);
  const points = db.transaction(() => {
    const rows = db.prepare("SELECT id,encrypted_data,created_at FROM net_worth_observation WHERE user_id=?").all(userId) as ObservationRow[];
    const observations = rows.map(row => ({ row, point: readObservation(row.encrypted_data, key) }));
    if (total !== null) {
      const point = { date, total };
      const encrypted = encryptBankValue(JSON.stringify({ ...point, accountCount, includedAccountCount, excludedAccountCount, unknownBalanceCount }), key);
      const existing = observations.find(value => value.point.date === date);
      if (existing) {
        db.prepare("UPDATE net_worth_observation SET encrypted_data=?,created_at=? WHERE id=? AND user_id=?")
          .run(encrypted, timestamp, existing.row.id, userId);
        existing.point = point;
        existing.row.created_at = timestamp;
      } else {
        const id = randomUUID();
        db.prepare("INSERT INTO net_worth_observation(id,user_id,encrypted_data,created_at) VALUES(?,?,?,?)")
          .run(id, userId, encrypted, timestamp);
        observations.push({ row: { id, encrypted_data: encrypted, created_at: timestamp }, point });
      }
    }
    return observations.filter(({ row, point }) => row.created_at <= timestamp && point.date >= firstDate && point.date <= date)
      .map(({ point }) => ({ date: point.date, total: point.total }))
      .sort((a, b) => a.date.localeCompare(b.date)).slice(-365);
  }).immediate();
  return { ...summary, points };
}
