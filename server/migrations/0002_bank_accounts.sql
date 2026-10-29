CREATE TABLE IF NOT EXISTS "bank_item" (
  "item_id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "institution_id" text,
  "encrypted_institution_name" text NOT NULL,
  "encrypted_access_token" text NOT NULL,
  "created_at" integer NOT NULL DEFAULT (unixepoch()),
  "updated_at" integer NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS "bank_item_user_id_idx" ON "bank_item" ("user_id");
CREATE UNIQUE INDEX IF NOT EXISTS "bank_item_item_user_id_idx"
  ON "bank_item" ("item_id", "user_id");

CREATE TABLE IF NOT EXISTS "bank_account" (
  "id" text PRIMARY KEY NOT NULL,
  "plaid_account_id" text NOT NULL,
  "item_id" text NOT NULL REFERENCES "bank_item"("item_id") ON DELETE CASCADE,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "encrypted_data" text NOT NULL,
  "updated_at" integer NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY ("item_id", "user_id")
    REFERENCES "bank_item"("item_id", "user_id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "bank_account_user_id_idx" ON "bank_account" ("user_id");
CREATE INDEX IF NOT EXISTS "bank_account_item_id_idx" ON "bank_account" ("item_id");
CREATE UNIQUE INDEX IF NOT EXISTS "bank_account_item_plaid_id_idx"
  ON "bank_account" ("item_id", "plaid_account_id");
