CREATE TABLE IF NOT EXISTS real_estate_connection (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
 address TEXT NOT NULL, latitude REAL NOT NULL, longitude REAL NOT NULL,
 created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS real_estate_connection_user_idx ON real_estate_connection(user_id);
CREATE TABLE IF NOT EXISTS real_estate_estimate (
 id TEXT PRIMARY KEY, connection_id TEXT NOT NULL REFERENCES real_estate_connection(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE, provider TEXT NOT NULL CHECK(provider='manual'),
 amount REAL NOT NULL CHECK(amount >= 0), created_at INTEGER NOT NULL DEFAULT (unixepoch()),
 FOREIGN KEY(connection_id,user_id) REFERENCES real_estate_connection(id,user_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS real_estate_connection_owner_id ON real_estate_connection(id,user_id);
CREATE INDEX IF NOT EXISTS real_estate_estimate_history_idx ON real_estate_estimate(user_id,connection_id,created_at);