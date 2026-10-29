import { mkdir, readFile, readdir } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";
import { applySqlMigration } from "./migration-utils.js";

const configuredDatabasePath: string =
  process.env["DATABASE_PATH"] ?? "./data/finance.sqlite";
const databasePath: string = isAbsolute(configuredDatabasePath)
  ? configuredDatabasePath
  : resolve(process.cwd(), configuredDatabasePath);
const migrationsDirectory: string = join(process.cwd(), "server", "migrations");

await mkdir(dirname(databasePath), { recursive: true });

export const sqliteClient = new Database(databasePath);
sqliteClient.pragma("journal_mode = WAL");
sqliteClient.pragma("foreign_keys = ON");
export const database = drizzle(sqliteClient, { schema });

export async function runMigrations(): Promise<void> {
  const migrationNames: string[] = (await readdir(migrationsDirectory))
    .filter((name: string): boolean => name.endsWith(".sql"))
    .sort();

  sqliteClient.exec(`
    CREATE TABLE IF NOT EXISTS app_migration (
      name text PRIMARY KEY,
      applied_at integer NOT NULL DEFAULT (unixepoch())
    )
  `);

  for (const name of migrationNames) {
    const existing: { name: string } | undefined = sqliteClient
      .prepare("SELECT name FROM app_migration WHERE name = ?")
      .get(name) as { name: string } | undefined;

    if (existing) {
      continue;
    }

    const migration: string = await readFile(join(migrationsDirectory, name), "utf8");
    const applyMigration = sqliteClient.transaction((): void => {
      applySqlMigration(sqliteClient, migration);
      sqliteClient
        .prepare("INSERT INTO app_migration (name) VALUES (?)")
        .run(name);
    });
    applyMigration();
  }
}

export async function checkDatabase(): Promise<void> {
  sqliteClient.prepare("SELECT 1").get();
}

export async function closeDatabase(): Promise<void> {
  sqliteClient.close();
}
