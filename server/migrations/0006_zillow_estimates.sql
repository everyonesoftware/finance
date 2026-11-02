CREATE TABLE real_estate_estimate_new (
 id TEXT PRIMARY KEY,
 connection_id TEXT NOT NULL REFERENCES real_estate_connection(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
 provider TEXT NOT NULL CHECK(provider IN ('manual','zillow')),
 amount REAL NOT NULL CHECK(amount >= 0),
 created_at INTEGER NOT NULL DEFAULT (unixepoch()),
 FOREIGN KEY(connection_id,user_id) REFERENCES real_estate_connection(id,user_id) ON DELETE CASCADE
);
INSERT INTO real_estate_estimate_new(id,connection_id,user_id,provider,amount,created_at)
 SELECT id,connection_id,user_id,provider,amount,created_at FROM real_estate_estimate;
DROP TABLE real_estate_estimate;
ALTER TABLE real_estate_estimate_new RENAME TO real_estate_estimate;
CREATE INDEX real_estate_estimate_history_idx ON real_estate_estimate(user_id,connection_id,created_at);
CREATE TABLE real_estate_zillow_request (
 user_id TEXT PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
 requested_at INTEGER NOT NULL
);
