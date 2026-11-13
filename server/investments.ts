import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { decryptBankValue, encryptBankValue } from './bank-crypto.js';
import { validBalanceDate, validMoney } from './account-balances.js';

export interface InvestmentHolding {
 symbol: string;
 name: string;
 quantity: number | null;
 price: number | null;
 marketValue: number;
 costBasis: number | null;
 isCash: boolean;
}
export interface InvestmentSnapshotInput {
 valuationDate: string;
 source: string;
 accountValue: number;
 cashBalance: number;
 holdings: InvestmentHolding[];
}
export interface InvestmentSnapshot extends InvestmentSnapshotInput { id: string; createdAt: string }
export class InvestmentError extends Error {
 constructor(message: string, public readonly status: 400 | 404 | 409) { super(message); }
}
const invalid = (): never => { throw new InvestmentError('Invalid investment snapshot fields or CSV. Use a real nonfuture valuation date, nonnegative amounts in cents and at most 1000 holdings.', 400); };
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
 return object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v);
const money = (v: unknown): v is number => validMoney(v) && v >= 0;
const fractional = (v: unknown): boolean => v === null || (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1e12);
const fields = ['valuationDate', 'source', 'accountValue', 'cashBalance', 'holdings'];
const holdingFields = ['symbol', 'name', 'quantity', 'price', 'marketValue', 'costBasis', 'isCash'];
export function validateInvestmentSnapshot(value: unknown, now: Date): InvestmentSnapshotInput {
 if (!exact(value, fields) || !validBalanceDate(value.valuationDate, now) || !text(value.source, 200) ||
  !money(value.accountValue) || !money(value.cashBalance) || !Array.isArray(value.holdings) || value.holdings.length > 1000) return invalid();
 let marketCents = BigInt(Math.round(value.cashBalance * 100)), basisCents = 0n;
 const maxCents = 100_000_000_000_000n;
 for (const h of value.holdings) {
  if (!exact(h, holdingFields) || !text(h.symbol, 100) || !text(h.name, 200) || !fractional(h.quantity) || !fractional(h.price) ||
   !money(h.marketValue) || !(h.costBasis === null || money(h.costBasis)) || typeof h.isCash !== 'boolean') return invalid();
  marketCents += BigInt(Math.round(h.marketValue * 100));
  if (h.costBasis !== null) basisCents += BigInt(Math.round(h.costBasis * 100));
  if (marketCents > maxCents || basisCents > maxCents) return invalid();
  if (h.isCash && value.cashBalance !== 0) throw new InvestmentError('Cash holdings require cashBalance to be zero to avoid counting core cash twice.', 400);
 }
 // Do not infer quantity*price or force source account value to equal holdings.
 return value as unknown as InvestmentSnapshotInput;
}

// Strict canonical CSV with escaped quotes, embedded newlines and CRLF support.
// Bounded independently of the router guard for safe reuse.
function csvRows(csv: string): string[][] {
 if (Buffer.byteLength(csv, 'utf8') > 5 * 1024 * 1024) return invalid();
 const rows: string[][] = []; let row: string[] = [], field = '', state: 'start' | 'plain' | 'quoted' | 'closed' = 'start';
 const endField = () => { row.push(field); field = ''; state = 'start'; if (row.length > 7) invalid(); };
 const endRow = () => { endField(); rows.push(row); row = []; if (rows.length > 1001) invalid(); };
 for (let i = 0; i < csv.length; i++) {
  const c = csv[i];
  if (state === 'quoted') {
   if (c === '"') { if (csv[i + 1] === '"') { field += '"'; i++; } else state = 'closed'; }
   else field += c;
  } else if (c === ',') endField();
  else if (c === '\n' || c === '\r') { if (c === '\r' && csv[i + 1] === '\n') i++; endRow(); }
  else if (c === '"' && state === 'start') state = 'quoted';
  else if (c === '"' || state === 'closed') return invalid();
  else { field += c; state = 'plain'; }
 }
 if (state === 'quoted') return invalid();
 if (state !== 'start' || field.length || row.length) endRow();
 return rows;
}
export function previewInvestmentSnapshot(body: unknown, now: Date): InvestmentSnapshotInput {
 if (!exact(body, ['valuationDate', 'source', 'accountValue', 'cashBalance', 'csv']) || typeof body.csv !== 'string') return invalid();
 const rows = csvRows(body.csv);
 if (!rows.length || rows[0].join(',') !== holdingFields.join(',') || rows[0].length !== 7) return invalid();
 const number = (v: string, optional: boolean): number | null => {
  if (v === '' && optional) return null;
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(v)) return invalid();
  const n = Number(v); if (!Number.isFinite(n)) return invalid(); return n;
 };
 const holdings = rows.slice(1).map(row => {
  if (row.length !== 7 || !['true', 'false'].includes(row[6])) return invalid();
  return { symbol: row[0], name: row[1], quantity: number(row[2], true), price: number(row[3], true),
   marketValue: number(row[4], false), costBasis: number(row[5], true), isCash: row[6] === 'true' };
 });
 return validateInvestmentSnapshot({ valuationDate: body.valuationDate, source: body.source, accountValue: body.accountValue, cashBalance: body.cashBalance, holdings }, now);
}

export function investmentDestination(db: Database.Database, key: Buffer, userId: string, accountId: string, write = false) {
 const row = db.prepare(`SELECT a.encrypted_data, i.provider FROM bank_account a
  JOIN bank_item i ON a.item_id=i.item_id AND a.user_id=i.user_id
  WHERE a.id=? AND a.user_id=? AND a.is_active=1 AND i.provider<>'legacy'`).get(accountId, userId) as { encrypted_data: string; provider: string } | undefined;
 if (!row) throw new InvestmentError('Account not found.', 404);
 const account = JSON.parse(decryptBankValue(row.encrypted_data, key)) as Record<string, unknown>;
 if (account.type !== 'investment') throw new InvestmentError('Investment snapshots require an investment account.', 409);
 if (write && row.provider !== 'manual') throw new InvestmentError('Saved investment accounts are read-only.', 409);
 return account;
}
export function listInvestmentSnapshots(db: Database.Database, key: Buffer, userId: string, accountId: string): InvestmentSnapshot[] {
 const rows = db.prepare('SELECT id,created_at,encrypted_data FROM investment_snapshot WHERE user_id=? AND account_id=?')
  .all(userId, accountId) as { id: string; created_at: string; encrypted_data: string }[];
 return rows.map(row => ({ ...JSON.parse(decryptBankValue(row.encrypted_data, key)), id: row.id, createdAt: row.created_at } as InvestmentSnapshot))
  .sort((a, b) => b.valuationDate.localeCompare(a.valuationDate) || b.createdAt.localeCompare(a.createdAt));
}
export function saveInvestmentSnapshot(db: Database.Database, key: Buffer, userId: string, accountId: string, value: unknown, now: Date): InvestmentSnapshot {
 const snapshot = validateInvestmentSnapshot(value, now);
 return db.transaction(() => {
  // Resolve again under BEGIN IMMEDIATE, so destination checks, encrypted insert,
  // current balance update and cache invalidation commit or roll back together.
  const account = investmentDestination(db, key, userId, accountId, true);
  const previous = listInvestmentSnapshots(db, key, userId, accountId);
  const lastCreated = previous.reduce((n, s) => Math.max(n, Date.parse(s.createdAt)), -Infinity);
  const createdAt = new Date(Math.max(now.getTime(), lastCreated + 1)).toISOString();
  const saved = { ...snapshot, id: randomUUID(), createdAt };
  db.prepare('INSERT INTO investment_snapshot(id,account_id,user_id,created_at,encrypted_data) VALUES(?,?,?,?,?)')
   .run(saved.id, accountId, userId, createdAt, encryptBankValue(JSON.stringify(snapshot), key));
  if (!previous.length || snapshot.valuationDate >= previous[0].valuationDate) {
   account.currentBalance = snapshot.accountValue;
   account.balanceReference = { amount: snapshot.accountValue, date: snapshot.valuationDate, verified: true };
   db.prepare('UPDATE bank_account SET encrypted_data=?,updated_at=unixepoch() WHERE id=? AND user_id=?')
    .run(encryptBankValue(JSON.stringify(account), key), accountId, userId);
  }
  return saved;
 }).immediate();
}
