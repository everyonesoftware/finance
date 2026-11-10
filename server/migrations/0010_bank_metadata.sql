-- normalize-bank-account-column
ALTER TABLE bank_item ADD COLUMN provider text NOT NULL DEFAULT 'legacy';
ALTER TABLE bank_item ADD COLUMN provider_application_id text;
ALTER TABLE bank_item ADD COLUMN provider_environment text;
ALTER TABLE bank_item ADD COLUMN provider_user_id text;
CREATE TABLE IF NOT EXISTS bank_connect_nonce (
  nonce_hash text PRIMARY KEY NOT NULL,
  user_id text NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  session_binding text NOT NULL,
  application_id text NOT NULL,
  environment text NOT NULL,
  expires_at integer NOT NULL
);
