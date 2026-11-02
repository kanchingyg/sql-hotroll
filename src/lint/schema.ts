/**
 * Reads tables, columns, foreign keys, and triggers from a SQLite database.
 *
 * @module
 */
import type { SqlDb } from "../sqlite-driver.ts";

export interface ColumnInfo {
  name: string;
  type: string;
  notNull: boolean;
  hasDefault: boolean;
  /** 0 for ordinary columns. 1 is a hidden virtual-table column, 2 and 3 are generated columns. */
  hidden: number;
}

export interface ForeignKey {
  parent: string;
  from: string[];
  /** Parent columns, resolved to the parent's primary key when the FK names none. */
  to: string[];
  onDelete: string;
}

export interface TableInfo {
  name: string;
  virtual: boolean;
  columns: ColumnInfo[];
  foreignKeys: ForeignKey[];
}

export interface Snapshot {
  tables: Map<string, TableInfo>;
  /** Trigger name to the table it is on. */
  triggers: Map<string, string>;
}

/** Bookkeeping tables written by migration runners, never by the migrations themselves. */
const RUNNER_TABLES = /^(sqlite_|_cf_|d1_migrations$|__drizzle_migrations$)/i;

export function snapshot(db: SqlDb): Snapshot {
  const listed = db.prepare("SELECT name, type FROM pragma_table_list WHERE schema = 'main'").all() as {
    name: string;
    type: string;
  }[];
  const tables = new Map<string, TableInfo>();
  for (const { name, type } of listed) {
    if (RUNNER_TABLES.test(name) || (type !== "table" && type !== "virtual")) continue;
    tables.set(name, { name, virtual: type === "virtual", columns: columns(db, name), foreignKeys: [] });
  }
  for (const table of tables.values()) table.foreignKeys = foreignKeys(db, table.name, tables);
  const triggers = new Map<string, string>();
  const rows = db.prepare("SELECT name, tbl_name FROM sqlite_schema WHERE type = 'trigger'").all() as {
    name: string;
    tbl_name: string;
  }[];
  for (const t of rows) triggers.set(t.name, t.tbl_name);
  return { tables, triggers };
}

function columns(db: SqlDb, table: string): ColumnInfo[] {
  const rows = db.prepare('SELECT name, type, "notnull", dflt_value, hidden FROM pragma_table_xinfo(?)').all(table) as {
    name: string;
    type: string;
    notnull: number;
    dflt_value: string | null;
    hidden: number;
  }[];
  return rows.map((r) => ({
    name: r.name,
    type: r.type,
    notNull: r.notnull === 1,
    hasDefault: r.dflt_value !== null,
    hidden: r.hidden,
  }));
}

function foreignKeys(db: SqlDb, table: string, tables: Map<string, TableInfo>): ForeignKey[] {
  const rows = db
    .prepare('SELECT id, "table", "from", "to", on_delete FROM pragma_foreign_key_list(?) ORDER BY id, seq')
    .all(table) as { id: number; table: string; from: string; to: string | null; on_delete: string }[];
  const byId = new Map<number, ForeignKey>();
  for (const r of rows) {
    let fk = byId.get(r.id);
    if (!fk) {
      fk = { parent: r.table, from: [], to: [], onDelete: r.on_delete.toUpperCase() };
      byId.set(r.id, fk);
    }
    fk.from.push(r.from);
    if (r.to !== null) fk.to.push(r.to);
  }
  for (const fk of byId.values()) {
    if (fk.to.length === 0 && tables.has(fk.parent)) fk.to = primaryKey(db, fk.parent);
  }
  return [...byId.values()];
}

function primaryKey(db: SqlDb, table: string): string[] {
  const rows = db.prepare("SELECT name FROM pragma_table_info(?) WHERE pk > 0 ORDER BY pk").all(table) as {
    name: string;
  }[];
  return rows.length > 0 ? rows.map((r) => r.name) : ["rowid"];
}

/** Quotes an identifier for SQLite. */
export const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;

export function rowCount(db: SqlDb, table: string): number {
  const [row] = db.prepare(`SELECT count(*) AS n FROM ${quote(table)}`).all() as { n: number }[];
  return Number(row?.n ?? 0);
}

export function nonNullCount(db: SqlDb, table: string, column: string): number {
  const [row] = db.prepare(`SELECT count(${quote(column)}) AS n FROM ${quote(table)}`).all() as { n: number }[];
  return Number(row?.n ?? 0);
}
