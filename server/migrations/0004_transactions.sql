ALTER TABLE bank_item ADD COLUMN encrypted_transaction_cursor text;

CREATE TABLE bank_transaction (
  transaction_id text NOT NULL,
  item_id text NOT NULL,
  user_id text NOT NULL,
  account_id text NOT NULL,
  encrypted_data text NOT NULL,
  updated_at integer NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (item_id, transaction_id),
  FOREIGN KEY (item_id, user_id) REFERENCES bank_item(item_id, user_id) ON DELETE CASCADE
);
CREATE INDEX bank_transaction_user_date_idx ON bank_transaction(user_id, item_id);
