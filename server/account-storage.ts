import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

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
