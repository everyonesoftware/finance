CREATE TABLE IF NOT EXISTS teller_settings (
  user_id text PRIMARY KEY NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  encrypted_data text NOT NULL,
  updated_at integer NOT NULL DEFAULT (unixepoch())
);
