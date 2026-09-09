import { createClient } from "@libsql/client/node";
import { drizzle } from "drizzle-orm/libsql";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const TEMPORARY_PREFIX = "campus-hire-tracker-";
const DATABASE_FILENAME = "真实 file smoke.db";

const smokeRows = sqliteTable("smoke_rows", {
  id: integer("id").primaryKey(),
  value: text("value").notNull(),
});

function validateTarget(databasePath) {
  const resolvedPath = path.resolve(databasePath);
  const temporaryRoot = path.resolve(tmpdir());
  const relation = path.relative(temporaryRoot, resolvedPath);
  const parentName = path.basename(path.dirname(resolvedPath));

  if (
    relation === "" ||
    relation === ".." ||
    relation.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relation) ||
    !parentName.startsWith(TEMPORARY_PREFIX) ||
    path.basename(resolvedPath) !== DATABASE_FILENAME
  ) {
    throw new Error("The database smoke worker received an unsafe target path.");
  }

  return resolvedPath;
}

async function main() {
  if (process.platform !== "win32" || process.arch !== "x64") {
    throw new Error("The native libSQL smoke worker only supports Windows x64.");
  }

  const argument = process.argv[2];
  if (!argument) {
    throw new Error("The database smoke worker requires a temporary database path.");
  }

  const databasePath = validateTarget(argument);
  const client = createClient({
    url: pathToFileURL(databasePath).href,
    concurrency: 1,
  });

  try {
    await client.execute("PRAGMA foreign_keys = ON");
    const foreignKeys = await client.execute("PRAGMA foreign_keys");
    const foreignKeyValue = foreignKeys.rows[0]?.foreign_keys;
    if (Number(foreignKeyValue) !== 1) {
      throw new Error("SQLite foreign key enforcement could not be enabled.");
    }

    await client.execute(
      "CREATE TABLE smoke_rows (id INTEGER PRIMARY KEY, value TEXT NOT NULL)",
    );

    const db = drizzle({ client });
    await db.transaction(async (transaction) => {
      await transaction.insert(smokeRows).values({
        id: 1,
        value: "中文路径与事务可用",
      });
    });

    const rows = await db.select().from(smokeRows);
    if (rows.length !== 1 || rows[0]?.value !== "中文路径与事务可用") {
      throw new Error("The Drizzle read-after-write check returned unexpected data.");
    }

    await client.execute(
      "CREATE TABLE smoke_parent (id INTEGER PRIMARY KEY)",
    );
    await client.execute(
      "CREATE TABLE smoke_child (id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES smoke_parent(id))",
    );

    let invalidForeignKeyWasRejected = false;
    try {
      await client.execute(
        "INSERT INTO smoke_child (id, parent_id) VALUES (1, 999)",
      );
    } catch {
      invalidForeignKeyWasRejected = true;
    }

    if (!invalidForeignKeyWasRejected) {
      throw new Error("SQLite accepted an invalid foreign key.");
    }
  } finally {
    client.close();
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[db:check:worker] FAILED: ${message}`);
  process.exitCode = 1;
});
