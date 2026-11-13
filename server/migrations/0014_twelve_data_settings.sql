CREATE TABLE twelve_data_settings (
  user_id text PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE,
  encrypted_api_key text NOT NULL
);
