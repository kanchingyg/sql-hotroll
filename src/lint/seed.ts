/**
 * Fills every table with a few synthetic rows that satisfy its foreign keys, parents first.
 *
 * @module
 */
import type { Param, SqlDb } from "../sqlite-driver.ts";
import { type ColumnInfo, quote, type Snapshot, type TableInfo } from "./schema.ts";

/** Seeding outcome per table: `null` when seeded, otherwise why it could not be. */
export type SeedResult = Map<string, string | null>;

export function seed(db: SqlDb, schema: Snapshot, rows: number): SeedResult {
  const result: SeedResult = new Map();
  const pending = new Set([...schema.tables.values()].filter((t) => !t.virtual).map((t) => t.name));
  for (const t of schema.tables.values()) if (t.virtual) result.set(t.name, "virtual table");
  let progress = true;
  while (pending.size > 0 && progress) {
    progress = false;
    for (const name of pending) {
      const table = schema.tables.get(name) as TableInfo;
      const waiting = table.foreignKeys.some((fk) => fk.parent !== name && pending.has(fk.parent));
      if (waiting) continue;
      result.set(name, seedTable(db, table, rows, result));
      pending.delete(name);
      progress = true;
    }
  }
  for (const name of pending) result.set(name, "foreign key cycle");
  return result;
}

function seedTable(db: SqlDb, table: TableInfo, rows: number, done: SeedResult): string | null {
  const parents = new Map<string, Param[][]>();
  for (const fk of table.foreignKeys) {
    const usable = fk.parent !== table.name && done.get(fk.parent) === null;
    const keys = usable
      ? (db.prepare(`SELECT ${fk.to.map(quote).join(", ")} FROM ${quote(fk.parent)}`).all() as Record<string, Param>[])
      : [];
    parents.set(
      fk.from.join("\0"),
      keys.map((row) => fk.to.map((c) => row[c] ?? null)),
    );
  }
  const writable = table.columns.filter((c) => c.hidden === 0);
  // Second attempt leaves defaulted and nullable columns to the schema, which gets past most CHECKs.
  const attempts = [writable, writable.filter((c) => c.notNull && !c.hasDefault)];
  let lastError = "";
  for (const cols of attempts) {
    const reason = tryInsert(db, table, cols, rows, parents);
    if (reason === null) return null;
    lastError = reason;
  }
  return lastError;
}

function tryInsert(
  db: SqlDb,
  table: TableInfo,
  cols: ColumnInfo[],
  rows: number,
  parents: Map<string, Param[][]>,
): string | null {
  const sql =
    cols.length === 0
      ? `INSERT INTO ${quote(table.name)} DEFAULT VALUES`
      : `INSERT INTO ${quote(table.name)} (${cols.map((c) => quote(c.name)).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`;
  db.exec("SAVEPOINT hotroll_seed");
  try {
    const insert = db.prepare(sql);
    for (let i = 0; i < rows; i++) {
      const values = cols.map((c) => valueFor(table, c, i, parents));
      if (values.includes(MISSING)) throw new Error(`${table.name} needs a row in a table that has none`);
      insert.run(...(values as Param[]));
    }
    db.exec("RELEASE hotroll_seed");
    return null;
  } catch (err) {
    db.exec("ROLLBACK TO hotroll_seed");
    db.exec("RELEASE hotroll_seed");
    return err instanceof Error ? err.message : String(err);
  }
}

const MISSING = Symbol("missing parent row");

function valueFor(
  table: TableInfo,
  col: ColumnInfo,
  i: number,
  parents: Map<string, Param[][]>,
): Param | typeof MISSING {
  for (const fk of table.foreignKeys) {
    const at = fk.from.indexOf(col.name);
    if (at < 0) continue;
    const keys = parents.get(fk.from.join("\0")) ?? [];
    if (keys.length === 0) return col.notNull ? MISSING : null;
    return (keys[i % keys.length] as Param[])[at] ?? null;
  }
  return byAffinity(col, i);
}

/** A distinct value per row, typed by SQLite's column affinity rules (datatype3.html, section 3.1). */
function byAffinity(col: ColumnInfo, i: number): Param {
  const type = col.type.toUpperCase();
  if (type.includes("INT")) return i + 1;
  if (/CHAR|CLOB|TEXT/.test(type)) return `${col.name}-${i + 1}`;
  if (type === "" || type.includes("BLOB")) return `${col.name}-${i + 1}`;
  if (/REAL|FLOA|DOUB/.test(type)) return i + 1.5;
  return i + 1;
}
