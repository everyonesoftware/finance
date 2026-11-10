import Database from "better-sqlite3";

export function applySqlMigration(
  database: InstanceType<typeof Database>,
  migration: string,
): void {
  if (migration.includes("-- normalize-bank-account-column")) {
    const columns = database.prepare('PRAGMA table_info("bank_account")').all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "provider_account_id")) {
      const candidates = columns.filter((column) => column.name.endsWith("_account_id") && column.name !== "id");
      if (candidates.length !== 1) throw new Error("Cannot discover the historical bank account identifier column.");
      const discovered = candidates[0]!.name.replaceAll('"', '""');
      database.exec(`ALTER TABLE "bank_account" RENAME COLUMN "${discovered}" TO "provider_account_id"`);
    }
  }
  const statements: string[] = migration
    .split(";")
    .map((statement): string => statement.trim())
    .filter((statement): boolean => statement.length > 0);

  const renameStatements: Array<{ from: string; to: string }> = [];
  for (const statement of statements) {
    const match: RegExpMatchArray | null = statement.match(
      /^ALTER TABLE "([a-zA-Z_][a-zA-Z0-9_]*)" RENAME TO "([a-zA-Z_][a-zA-Z0-9_]*)"$/,
    );
    if (!match?.[1] || !match[2]) {
      database.exec(migration);
      return;
    }
    renameStatements.push({ from: match[1], to: match[2] });
  }

  for (const rename of renameStatements) {
    const sourceExists: boolean = tableExists(database, rename.from);
    const targetExists: boolean = tableExists(database, rename.to);

    if (sourceExists && targetExists) {
      throw new Error(
        `Cannot rename table ${rename.from}; both source and target tables exist.`,
      );
    }
    if (!sourceExists && !targetExists) {
      throw new Error(
        `Cannot rename table ${rename.from}; neither source nor target exists.`,
      );
    }
    if (sourceExists) {
      database.exec(
        `ALTER TABLE "${rename.from}" RENAME TO "${rename.to}"`,
      );
    }
  }
}

function tableExists(
  database: InstanceType<typeof Database>,
  name: string,
): boolean {
  const result: { found: number } | undefined = database
    .prepare(
      "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?",
    )
    .get(name) as { found: number } | undefined;
  return result !== undefined;
}
