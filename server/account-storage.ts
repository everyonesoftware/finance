import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { decryptPlaidValue } from "./plaid.js";
import { getRecentTransactions } from "./transaction-sync.js";

export interface BankAccountSnapshotWrite {
  plaidAccountId: string;
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
      plaid_account_id,
      item_id,
      user_id,
      encrypted_data,
      is_active
    ) VALUES (?, ?, ?, ?, ?, 1)
    ON CONFLICT(item_id, plaid_account_id) DO UPDATE SET
      encrypted_data = excluded.encrypted_data,
      is_active = 1,
      updated_at = unixepoch()
  `);

  for (const snapshot of snapshots) {
    upsert.run(
      randomUUID(),
      snapshot.plaidAccountId,
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
  plaidAccountId: string,
  encryptionKey: Buffer,
): Array<Record<string, unknown>> {
  const rows = sqliteClient
    .prepare(`
      SELECT encrypted_data AS encryptedData
      FROM bank_transaction
      WHERE user_id = ? AND item_id = ? AND account_id = ?
    `)
    .all(userId, itemId, plaidAccountId) as Array<{ encryptedData: string }>;
  const transactions = rows.map((row) =>
    JSON.parse(decryptPlaidValue(row.encryptedData, encryptionKey)) as Record<string, unknown> & { date?: unknown },
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
    `)
    .all(userId) as Array<{ encryptedData: string }>;
  return rows.map((row) =>
    JSON.parse(decryptPlaidValue(row.encryptedData, encryptionKey)) as Record<string, unknown>,
  );
}
