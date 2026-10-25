CREATE TABLE IF NOT EXISTS "user" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "email" text NOT NULL UNIQUE,
  "email_verified" integer NOT NULL DEFAULT 0,
  "image" text,
  "username" text UNIQUE,
  "display_username" text,
  "created_at" integer NOT NULL DEFAULT (unixepoch()),
  "updated_at" integer NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS "session" (
  "id" text PRIMARY KEY NOT NULL,
  "expires_at" integer NOT NULL,
  "token" text NOT NULL UNIQUE,
  "created_at" integer NOT NULL DEFAULT (unixepoch()),
  "updated_at" integer NOT NULL DEFAULT (unixepoch()),
  "ip_address" text,
  "user_agent" text,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "session_user_id_idx" ON "session" ("user_id");

CREATE TABLE IF NOT EXISTS "user_account" (
  "id" text PRIMARY KEY NOT NULL,
  "account_id" text NOT NULL,
  "provider_id" text NOT NULL,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "access_token" text,
  "refresh_token" text,
  "id_token" text,
  "access_token_expires_at" integer,
  "refresh_token_expires_at" integer,
  "scope" text,
  "password" text,
  "created_at" integer NOT NULL DEFAULT (unixepoch()),
  "updated_at" integer NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS "account_user_id_idx" ON "user_account" ("user_id");

CREATE TABLE IF NOT EXISTS "user_verification" (
  "id" text PRIMARY KEY NOT NULL,
  "identifier" text NOT NULL,
  "value" text NOT NULL,
  "expires_at" integer NOT NULL,
  "created_at" integer NOT NULL DEFAULT (unixepoch()),
  "updated_at" integer NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS "verification_identifier_idx"
  ON "user_verification" ("identifier");
