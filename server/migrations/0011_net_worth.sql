-- Observation dates and financial amounts are kept inside encrypted_data.
CREATE TABLE IF NOT EXISTS net_worth_observation (
  id text PRIMARY KEY NOT NULL,
  user_id text NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  encrypted_data text NOT NULL,
  created_at integer NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS net_worth_observation_owner ON net_worth_observation(user_id);
