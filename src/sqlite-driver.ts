/**
 * Opens a synchronous SQLite database through `node:sqlite`, on Node 22.13+ and on Bun.
 *
 * Bun's own `bun:sqlite` is not used: in Bun 1.4.2 its multi-statement `exec` keeps going after a
 * statement fails at step time (a NOT NULL or foreign key error) without throwing, and it throws on
 * SQL that is only comments. Both would make the linter report the wrong result.
 *
 * @module
 */

/** A value bound to a `?` placeholder. */
export type Param = string | number | bigint | null | Uint8Array;

/**
 * The subset of a synchronous SQLite driver that the CLI uses. `node:sqlite`, `bun:sqlite`, and
 * the `libsql` package all fit (tests run the expand engine on two of them). The async
 * `@libsql/client` does not.
 */
export interface SqlDb {
  exec(sql: string): void;
  prepare(sql: string): {
    all(...params: Param[]): unknown[];
    run(...params: Param[]): { changes: number | bigint };
    /** The part of `sql` that was compiled (`node:sqlite` only; prepare ignores anything after it). */
    readonly sourceSQL?: string;
  };
  close(): void;
}

/** Opens `path` (or `:memory:`) with foreign keys on, as Cloudflare D1 always has them. */
export async function openDatabase(path: string): Promise<SqlDb> {
  const db: SqlDb = new (await import("node:sqlite")).DatabaseSync(path);
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
