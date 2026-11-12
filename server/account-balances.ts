import { createHmac } from 'node:crypto';
import type { ImportAccount, ImportCandidate } from './import-candidates.js';
import { ImportConflictError } from './import-candidates.js';

export interface BalanceReference { amount: number; date: string; verified: boolean }
export interface BalanceImpact {
 referenceBalance: number | null;
 referenceDate: string | null;
 startingBalance: number | null;
 historicalCount: number;
 appliedCount: number;
 appliedAmount: number;
 duplicates: number;
 balanceAfterImport: number | null;
 canApply: boolean;
 reason?: string;
}
// Leave ample precision for cents -> dollar Number -> cents roundtrips,
// including the intermediate balances carried between batch files.
const MAX_MONEY = 1_000_000_000_000;
const MAX_CENTS = BigInt(MAX_MONEY) * 100n;
export function validMoney(value: unknown): value is number {
 return typeof value === 'number' && Number.isFinite(value) &&
  Math.abs(value) <= MAX_MONEY &&
  Number(value.toFixed(2)) === value && Number.isSafeInteger(Math.round(value * 100));
}
export function validBalanceDate(value: unknown, now: Date): value is string {
 if (typeof value !== 'string' || !/^[1-9]\d{3}-\d{2}-\d{2}$/.test(value)) return false;
 const parsed = new Date(value + 'T00:00:00Z');
 return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value && value <= now.toISOString().slice(0, 10);
}
function reference(account: ImportAccount): BalanceReference | undefined {
 const ref = account.balanceReference as BalanceReference | undefined;
 return ref && validMoney(ref.amount) && typeof ref.date === 'string' ? ref : undefined;
}
function cents(amount: number): bigint {
 if (!validMoney(amount)) throw new ImportConflictError('Amount is outside the supported monetary range or is not in cents.');
 return BigInt(Math.round(amount * 100));
}
function dollars(value: bigint): number {
 if (value > MAX_CENTS || value < -MAX_CENTS) {
  throw new ImportConflictError('Resulting balance is outside the supported monetary range.');
 }
 return Number(value) / 100;
}
const direction = (account: ImportAccount) => account.type === 'credit' || account.type === 'loan' ? 1n : -1n;

// Derive from the immutable encrypted reference and every saved posted row;
// never mutate a snapshot during imports or reconstruct unverified history.
export function deriveBalance(account: ImportAccount, transactions: Array<Record<string, unknown>>): number | null {
 const ref = reference(account);
 if (!ref || account.source !== 'manual') return typeof account.currentBalance === 'number' ? account.currentBalance : null;
 if (account.type === 'investment') return ref.amount;
 let total = cents(ref.amount);
 for (const tx of transactions) {
  if (tx.pending === true || typeof tx.date !== 'string' || tx.date <= ref.date) continue;
  if (!validMoney(tx.amount)) throw Error('Invalid stored transaction amount.');
  total += direction(account) * cents(tx.amount);
 }
 return dollars(total);
}

export function balanceImpact(account: ImportAccount | undefined, fresh: ImportCandidate[], duplicates: number,
 starting?: number | null, invalidReason?: string): BalanceImpact {
 const ref = account ? reference(account) : undefined;
 const current = starting !== undefined ? starting : typeof account?.currentBalance === 'number' ? account.currentBalance : null;
 const blockedReason = invalidReason ?? (!account ? 'Select a destination account.' :
  account.type === 'investment' ? 'Investment valuations cannot be inferred from transaction cash activity.' :
  !ref ? 'Set a dated balance reference before applying transaction activity.' : undefined);
 const canApply = !blockedReason;
 const reason = blockedReason ?? (ref?.verified === false ? 'The default zero balance reference is unverified; adjust it to your actual balance when known.' : undefined);
 const historicalCount = ref ? fresh.filter(c => c.tx.date <= ref.date).length : 0;
 const later = canApply && ref ? fresh.filter(c => c.tx.date > ref.date) : [];
 const delta = later.reduce((sum, c) => sum + direction(account!) * cents(c.tx.amount), 0n);
 return {
  referenceBalance: ref?.amount ?? (typeof account?.currentBalance === 'number' ? account.currentBalance : null),
  referenceDate: ref?.date ?? null, startingBalance: current, historicalCount,
  appliedCount: later.length, appliedAmount: dollars(delta), duplicates,
  balanceAfterImport: current === null || !canApply ? current : dollars(cents(current) + delta),
  canApply, ...(reason ? { reason } : {}),
 };
}

// Bind approval to the reference, derived balance, contents and classification.
export function balancePreviewToken(key: Buffer, userId: string, state: unknown): string {
 return createHmac('sha256', key).update(JSON.stringify([userId, state])).digest('hex');
}