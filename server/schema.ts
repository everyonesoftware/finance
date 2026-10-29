import {
  foreignKey,
  integer,
  index,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const user = sqliteTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: integer("email_verified", { mode: "boolean" }).notNull().default(false),
  image: text("image"),
  username: text("username").unique(),
  displayUsername: text("display_username"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

export const session = sqliteTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
    token: text("token").notNull().unique(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [index("session_user_id_idx").on(table.userId)],
);

export const account = sqliteTable(
  "user_account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: integer("access_token_expires_at", { mode: "timestamp" }),
    refreshTokenExpiresAt: integer("refresh_token_expires_at", { mode: "timestamp" }),
    scope: text("scope"),
    password: text("password"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [index("account_user_id_idx").on(table.userId)],
);

export const verification = sqliteTable(
  "user_verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [index("verification_identifier_idx").on(table.identifier)],
);

export const bankItem = sqliteTable(
  "bank_item",
  {
    itemId: text("item_id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    institutionId: text("institution_id"),
    encryptedInstitutionName: text("encrypted_institution_name").notNull(),
    encryptedAccessToken: text("encrypted_access_token").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    index("bank_item_user_id_idx").on(table.userId),
    uniqueIndex("bank_item_item_user_id_idx").on(table.itemId, table.userId),
  ],
);

export const bankAccount = sqliteTable(
  "bank_account",
  {
    id: text("id").primaryKey(),
    plaidAccountId: text("plaid_account_id").notNull(),
    itemId: text("item_id")
      .notNull()
      .references(() => bankItem.itemId, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    encryptedData: text("encrypted_data").notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    index("bank_account_user_id_idx").on(table.userId),
    index("bank_account_item_id_idx").on(table.itemId),
    uniqueIndex("bank_account_item_plaid_id_idx").on(table.itemId, table.plaidAccountId),
    foreignKey({
      columns: [table.itemId, table.userId],
      foreignColumns: [bankItem.itemId, bankItem.userId],
      name: "bank_account_item_owner_fk",
    }).onDelete("cascade"),
  ],
);
