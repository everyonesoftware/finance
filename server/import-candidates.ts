import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { decryptBankValue, encryptBankValue } from './bank-crypto.js';
import type { ImportedTransaction } from './transaction-import.js';

export class ImportConflictError extends Error {}
export interface ImportCandidate { id: string; fingerprint: string; tx: ImportedTransaction }
export type ImportAccount = Record<string, unknown>;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function importCandidates(transactions: ImportedTransaction[], userId: string, account: ImportAccount): ImportCandidate[] {
 const occurrences = new Map<string, number>();
 return transactions.map(tx => {
  const fingerprint = hash([tx.date, tx.name, tx.amount, tx.iso_currency_code]);
  const occurrence = (occurrences.get(fingerprint) ?? 0) + 1;
  occurrences.set(fingerprint, occurrence);
  // Preserve the existing single-file identity, including per-file occurrence ranks.
  const identity = tx.sourceId !== undefined ? ['source', tx.sourceId] : ['row', fingerprint, occurrence];
  return { id: hash([userId, account.id, identity]), fingerprint, tx };
 });
}

export function classifyImport(db: Database.Database, key: Buffer, userId: string, account: ImportAccount,
 candidates: ImportCandidate[], seen = new Map<string, string>(), conflicts?: Set<string>) {
 const lookup = db.prepare('SELECT encrypted_data FROM bank_transaction WHERE transaction_id=? AND user_id=? AND account_id=?');
 let duplicates = 0;
 const fresh: ImportCandidate[] = [];
 for (const candidate of candidates) {
  const existing = lookup.get(candidate.id, userId, account.providerAccountId) as { encrypted_data: string } | undefined;
  const old = existing ? JSON.parse(decryptBankValue(existing.encrypted_data, key)) : undefined;
  const previous = old?.importFingerprint ?? seen.get(candidate.id);
  if (previous && previous !== candidate.fingerprint) {
   if (conflicts) { conflicts.add(candidate.id); continue; }
   throw new ImportConflictError('A source transaction ID conflicts with previously imported contents.');
  }
  if (previous) duplicates++;
  else fresh.push(candidate);
  seen.set(candidate.id, candidate.fingerprint);
 }
 return { duplicates, fresh };
}

export function writeImport(db: Database.Database, key: Buffer, userId: string, account: ImportAccount,
 fileName: string, fresh: ImportCandidate[]): void {
 const insert = db.prepare('INSERT INTO bank_transaction(transaction_id,item_id,user_id,account_id,encrypted_data) VALUES(?,?,?,?,?)');
 for (const {id, fingerprint, tx} of fresh) {
  const payload = {...tx, transaction_id: id, account_id: account.providerAccountId, pending: false, importFingerprint: fingerprint, importFileName: fileName};
  insert.run(id, account.itemId, userId, account.providerAccountId, encryptBankValue(JSON.stringify(payload), key));
 }
 // Keep the encrypted reference immutable; account reads derive the current
 // balance from all saved posted transactions after its end-of-day date.
}
