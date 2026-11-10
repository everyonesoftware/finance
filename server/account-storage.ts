import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { decryptBankValue } from "./bank-crypto.js";
import { getRecentTransactions } from "./transaction-sync.js";

export interface BankAccountSnapshotWrite {
  providerAccountId: string;
  encryptedData: string;
}

export function refreshBankAccountSnapshots(
  sqliteClient: Database.Database,
  itemId: string,
  userId: string,
  snapshots: BankAccountSnapshotWrite[],
): void {
  sqliteClient
    .prepare(
      "UPDATE bank_account SET is_active = 0 WHERE item_id = ? AND user_id = ?",
    )
    .run(itemId, userId);

  const upsert = sqliteClient.prepare(`
    INSERT INTO bank_account (
      id,
      provider_account_id,
      item_id,
      user_id,
      encrypted_data,
      is_active
    ) VALUES (?, ?, ?, ?, ?, 1)
    ON CONFLICT(item_id, provider_account_id) DO UPDATE SET
      encrypted_data = excluded.encrypted_data,
      is_active = 1,
      updated_at = unixepoch()
  `);

  for (const snapshot of snapshots) {
    upsert.run(
      randomUUID(),
      snapshot.providerAccountId,
      itemId,
      userId,
      snapshot.encryptedData,
    );
  }
}

export function listAccountTransactions(
  sqliteClient: Database.Database,
  userId: string,
  itemId: string,
  providerAccountId: string,
  encryptionKey: Buffer,
): Array<Record<string, unknown>> {
  const rows = sqliteClient
    .prepare(`
      SELECT encrypted_data AS encryptedData
      FROM bank_transaction
      WHERE user_id = ? AND item_id = ? AND account_id = ?
        AND EXISTS (SELECT 1 FROM bank_item i WHERE i.item_id=bank_transaction.item_id AND i.user_id=bank_transaction.user_id AND i.provider <> 'legacy')
    `)
    .all(userId, itemId, providerAccountId) as Array<{ encryptedData: string }>;
  const transactions = rows.map((row) =>
    JSON.parse(decryptBankValue(row.encryptedData, encryptionKey)) as Record<string, unknown> & { date?: unknown },
  );
  return getRecentTransactions(transactions);
}

export function listAllUserTransactions(
  sqliteClient: Database.Database,
  userId: string,
  encryptionKey: Buffer,
): Array<Record<string, unknown>> {
  const rows = sqliteClient
    .prepare(`
      SELECT encrypted_data AS encryptedData
      FROM bank_transaction
      WHERE user_id = ?
        AND EXISTS (SELECT 1 FROM bank_item i WHERE i.item_id=bank_transaction.item_id AND i.user_id=bank_transaction.user_id AND i.provider <> 'legacy')
    `)
    .all(userId) as Array<{ encryptedData: string }>;
  return rows.map((row) =>
    JSON.parse(decryptBankValue(row.encryptedData, encryptionKey)) as Record<string, unknown>,
  );
}
