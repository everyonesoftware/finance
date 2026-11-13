-- Holdings, valuation dates, source labels and amounts remain encrypted.
CREATE UNIQUE INDEX IF NOT EXISTS bank_account_id_user_idx ON bank_account(id, user_id);
CREATE TABLE IF NOT EXISTS investment_snapshot (
  id text PRIMARY KEY NOT NULL,
  account_id text NOT NULL,
  user_id text NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  created_at text NOT NULL,
  encrypted_data text NOT NULL,
  FOREIGN KEY(account_id, user_id) REFERENCES bank_account(id, user_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS investment_snapshot_owner_account_idx ON investment_snapshot(user_id, account_id);
-- Corrections are new observations, never replacements. Deletion remains available
-- to account/owner cascades for privacy; there is no snapshot deletion endpoint.
CREATE TRIGGER IF NOT EXISTS investment_snapshot_immutable BEFORE UPDATE ON investment_snapshot BEGIN
  SELECT RAISE(ABORT, 'Investment snapshots are immutable.');
END;
