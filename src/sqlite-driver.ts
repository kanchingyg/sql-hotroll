/**
 * Opens a synchronous SQLite database on Bun (`bun:sqlite`) or Node 22+ (`node:sqlite`).
 *
 * @module
 */

/** A value bound to a `?` placeholder. */
export type Param = string | number | bigint | null | Uint8Array;

/**
 * The subset of a synchronous SQLite driver that the CLI uses. `bun:sqlite`, `node:sqlite`,
 * and the `libsql` package all fit. The async `@libsql/client` does not.
 */
export interface SqlDb {
  exec(sql: string): void;
  prepare(sql: string): { all(...params: Param[]): unknown[]; run(...params: Param[]): unknown };
  close(): void;
}

/** Opens `path` (or `:memory:`) with foreign keys on, as Cloudflare D1 always has them. */
export async function openDatabase(path: string): Promise<SqlDb> {
  const db: SqlDb =
    typeof Bun === "undefined"
      ? new (await import("node:sqlite")).DatabaseSync(path)
      : new (await import("bun:sqlite")).Database(path);
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

/**
 * Runs `fn` inside BEGIN IMMEDIATE, rolling back if it throws. Taking the write lock up front
 * means validation and DDL see the same schema.
 */
export function transaction<T>(db: SqlDb, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
