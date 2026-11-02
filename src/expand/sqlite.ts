/**
 * Expand/contract schema migrations for SQLite and libSQL using one view per schema version.
 *
 * expand   adds new columns under temporary names, then rebuilds `<table>_v<from>` and creates
 *          `<table>_v<to>`. Each view has INSTEAD OF triggers that write its own columns and
 *          derive the other version's columns, so old and new clients can both read and write.
 * backfill fills the new columns for rows written before expand, in short write transactions.
 * contract drops the old view and old columns and gives the new columns their final names.
 * abort    drops the new view and new columns and restores the old view.
 *
 * Applications must read and write through the version views once a table is adopted.
 *
 * @module
 */
import { type SqlDb, transaction } from "../sqlite-driver.ts";
import { ident, type Layout, type Migration, resolveLayout, sqlType } from "./plan.ts";

export type Phase = "stable" | "expanded";

/** A migration between expand and contract, with column types resolved at expand time. */
export interface Pending {
  migration: Migration;
  layout: Layout;
}

export interface TableState {
  table: string;
  key: string;
  version: number;
  phase: Phase;
  pending: Pending | null;
}

interface Column {
  name: string;
  physical: string;
  /** Generated columns: readable through the view, never written. */
  readonly: boolean;
}

interface ViewSpec {
  table: string;
  key: string;
  version: number;
  /** Every non-key column the view exposes. */
  columns: Column[];
  /** Physical columns filled after each write by evaluating `expr` against this view's row. */
  derived: { physical: string; expr: string }[];
}

const STATE = "_hotroll_state";
const INTERNAL = /^_hr\d+_/;
const syncedFlag = (to: number) => `_hr${to}_synced`;

export const viewName = (table: string, version: number): string => `${table}_v${version}`;

export function adopt(db: SqlDb, table: string, key: string, version = 1): void {
  if (!Number.isInteger(version) || version < 1) throw new Error(`version must be a positive integer (got ${version})`);
  transaction(db, () => {
    if (readState(db, table)) throw new Error(`${table} is already adopted`);
    const [pk] = db.prepare("SELECT type, pk FROM pragma_table_info(?) WHERE name = ?").all(table, key) as {
      type: string;
      pk: number;
    }[];
    if (pk?.pk !== 1 || pk.type.toUpperCase() !== "INTEGER") {
      throw new Error(`${table}.${key} must be the table's INTEGER PRIMARY KEY`);
    }
    createPassthrough(db, table, key, version);
    db.prepare(`INSERT INTO ${STATE} (tbl, key, version, plan) VALUES (?, ?, ?, NULL)`).run(table, key, version);
  });
}

export function expand(db: SqlDb, m: Migration): void {
  transaction(db, () => {
    const state = requireState(db, m.table, "stable");
    if (state.version !== m.from) throw new Error(`${m.table} is at v${state.version}, migration starts at v${m.from}`);
    if (state.key !== m.key) throw new Error(`${m.table} is keyed by ${state.key}, migration says ${m.key}`);
    const existing = new Map(tableColumns(db, m.table).map((c) => [c.name, c]));
    const layout = resolveLayout(m, (c) => existing.get(c)?.type ?? "");
    const oldNames = new Set(layout.oldOnly.map((c) => c.name));
    for (const name of oldNames) {
      const col = existing.get(name);
      if (!col) throw new Error(`${m.table}.${name} does not exist`);
      if (col.readonly) throw new Error(`${m.table}.${name} is a generated column; migrate its source columns instead`);
    }
    for (const c of layout.newOnly) {
      if (existing.has(c.name) && !oldNames.has(c.name))
        throw new Error(`${m.table}.${c.name} already exists in v${m.from}`);
    }
    const shared = [...existing.values()].filter((c) => c.name !== m.key && !oldNames.has(c.name));

    const t = ident(m.table);
    for (const c of layout.newOnly) db.exec(`ALTER TABLE ${t} ADD COLUMN ${ident(c.physical)} ${sqlType(c.type)}`);
    db.exec(`ALTER TABLE ${t} ADD COLUMN ${ident(syncedFlag(m.to))} INTEGER`);
    dropView(db, m.table, m.from);
    for (const spec of expandedViews(m, shared, layout)) createView(db, spec);
    const pending: Pending = { migration: m, layout };
    db.prepare(`UPDATE ${STATE} SET plan = ? WHERE tbl = ?`).run(JSON.stringify(pending), m.table);
  });
}

export interface BackfillOptions {
  batchSize?: number;
  /** Runs `PRAGMA wal_checkpoint(PASSIVE)` after each batch so the WAL file stays small. */
  checkpoint?: boolean;
}

/** Fills new columns for rows not yet written through a version view. Returns rows updated. */
export function backfill(db: SqlDb, table: string, opts: BackfillOptions = {}): number {
  const batch = opts.batchSize ?? 500;
  if (!Number.isInteger(batch) || batch < 1) throw new Error(`batchSize must be a positive integer (got ${batch})`);
  const { migration: m, layout } = requirePending(db, table);
  const t = ident(table);
  const key = ident(m.key);
  const flag = ident(syncedFlag(m.to));
  const from = ident(viewName(table, m.from));
  const sets = [
    ...layout.newOnly.map(
      (c) => `${ident(c.physical)} = (SELECT ${c.up} FROM ${from} AS s WHERE s.${key} = ${t}.${key})`,
    ),
    `${flag} = 1`,
  ].join(", ");
  const update = db.prepare(
    `UPDATE ${t} SET ${sets} WHERE ${key} IN (SELECT ${key} FROM ${t} WHERE ${flag} IS NULL ORDER BY ${key} LIMIT ${batch}) RETURNING ${key}`,
  );
  let total = 0;
  for (;;) {
    let n = 0;
    transaction(db, () => {
      n = update.all().length;
    });
    total += n;
    if (opts.checkpoint) db.exec("PRAGMA wal_checkpoint(PASSIVE)");
    if (n < batch) return total;
  }
}

/** Rows that still need a backfill before contract is allowed. */
export function pendingRows(db: SqlDb, table: string): number {
  const { migration: m } = requirePending(db, table);
  const [row] = db
    .prepare(`SELECT count(*) AS n FROM ${ident(table)} WHERE ${ident(syncedFlag(m.to))} IS NULL`)
    .all() as { n: number }[];
  return row?.n ?? 0;
}

/** Removes the old version. Call only after the old version has no live sessions (see DrainTracker). */
export function contract(db: SqlDb, table: string): void {
  transaction(db, () => {
    const { migration: m, layout } = requirePending(db, table);
    const left = pendingRows(db, table);
    if (left > 0) throw new Error(`${left} rows of ${table} are not backfilled; run backfill first`);
    finish(db, m, {
      keep: m.to,
      drop: layout.oldOnly.map((c) => c.name),
      rename: layout.newOnly.map((c) => [c.physical, c.name]),
    });
  });
}

/** Cancels a pending migration. Writes made through the new view survive in the old columns. */
export function abort(db: SqlDb, table: string): void {
  transaction(db, () => {
    const { migration: m, layout } = requirePending(db, table);
    finish(db, m, { keep: m.from, drop: layout.newOnly.map((c) => c.physical), rename: [] });
  });
}

export function status(db: SqlDb): TableState[] {
  ensureStateTable(db);
  const rows = db.prepare(`SELECT tbl, key, version, plan FROM ${STATE} ORDER BY tbl`).all() as StateRow[];
  return rows.map(toState);
}

/** Shared tail of contract and abort: one version survives as a pass-through view. */
function finish(db: SqlDb, m: Migration, end: { keep: number; drop: string[]; rename: [string, string][] }): void {
  const t = ident(m.table);
  dropView(db, m.table, m.from);
  dropView(db, m.table, m.to);
  for (const c of [...end.drop, syncedFlag(m.to)]) db.exec(`ALTER TABLE ${t} DROP COLUMN ${ident(c)}`);
  for (const [from, to] of end.rename) db.exec(`ALTER TABLE ${t} RENAME COLUMN ${ident(from)} TO ${ident(to)}`);
  createPassthrough(db, m.table, m.key, end.keep);
  db.prepare(`UPDATE ${STATE} SET version = ?, plan = NULL WHERE tbl = ?`).run(end.keep, m.table);
}

function expandedViews(m: Migration, shared: Column[], layout: Layout): ViewSpec[] {
  const flag = { physical: syncedFlag(m.to), expr: "1" };
  return [
    {
      table: m.table,
      key: m.key,
      version: m.from,
      columns: [...shared, ...layout.oldOnly.map((c) => ({ name: c.name, physical: c.name, readonly: false }))],
      derived: [...layout.newOnly.map((c) => ({ physical: c.physical, expr: c.up })), flag],
    },
    {
      table: m.table,
      key: m.key,
      version: m.to,
      columns: [...shared, ...layout.newOnly.map((c) => ({ name: c.name, physical: c.physical, readonly: false }))],
      derived: [...layout.oldOnly.map((c) => ({ physical: c.name, expr: c.down ?? "NULL" })), flag],
    },
  ];
}

function createPassthrough(db: SqlDb, table: string, key: string, version: number): void {
  const columns = tableColumns(db, table).filter((c) => c.name !== key);
  createView(db, { table, key, version, columns, derived: [] });
}

function createView(db: SqlDb, v: ViewSpec): void {
  const t = ident(v.table);
  const name = viewName(v.table, v.version);
  const view = ident(name);
  const key = ident(v.key);
  const select = [key, ...v.columns.map((c) => `${ident(c.physical)} AS ${ident(c.name)}`)].join(", ");
  db.exec(`CREATE VIEW ${view} AS SELECT ${select} FROM ${t}`);

  const writable = v.columns.filter((c) => !c.readonly);
  const targets = [key, ...writable.map((c) => ident(c.physical))];
  const values = [`NEW.${key}`, ...writable.map((c) => `NEW.${ident(c.name)}`)];
  const derive = (row: string) =>
    v.derived.length === 0
      ? ""
      : `UPDATE ${t} SET ${v.derived
          .map((d) => `${ident(d.physical)} = (SELECT ${d.expr} FROM ${view} AS s WHERE s.${key} = ${row})`)
          .join(", ")} WHERE ${key} = ${row};`;

  // last_insert_rowid() inside a trigger returns the row the trigger just inserted.
  db.exec(`CREATE TRIGGER ${ident(`${name}_ins`)} INSTEAD OF INSERT ON ${view} BEGIN
    INSERT INTO ${t} (${targets.join(", ")}) VALUES (${values.join(", ")});
    ${derive("last_insert_rowid()")}
  END`);
  db.exec(`CREATE TRIGGER ${ident(`${name}_upd`)} INSTEAD OF UPDATE ON ${view} BEGIN
    UPDATE ${t} SET ${targets.map((p, i) => `${p} = ${values[i]}`).join(", ")} WHERE ${key} = OLD.${key};
    ${derive(`NEW.${key}`)}
  END`);
  db.exec(`CREATE TRIGGER ${ident(`${name}_del`)} INSTEAD OF DELETE ON ${view} BEGIN
    DELETE FROM ${t} WHERE ${key} = OLD.${key};
  END`);
}

function dropView(db: SqlDb, table: string, version: number): void {
  db.exec(`DROP VIEW IF EXISTS ${ident(viewName(table, version))}`);
}

/**
 * User-visible columns from `PRAGMA table_xinfo`. hidden = 1 marks virtual-table hidden columns
 * (skipped); 2 and 3 mark VIRTUAL and STORED generated columns (read-only).
 */
function tableColumns(db: SqlDb, table: string): (Column & { type: string })[] {
  const rows = db.prepare("SELECT name, type, hidden FROM pragma_table_xinfo(?)").all(table) as {
    name: string;
    type: string;
    hidden: number;
  }[];
  if (rows.length === 0) throw new Error(`table ${table} does not exist`);
  return rows
    .filter((c) => c.hidden !== 1 && !INTERNAL.test(c.name))
    .map((c) => ({ name: c.name, physical: c.name, type: c.type, readonly: c.hidden >= 2 }));
}

interface StateRow {
  tbl: string;
  key: string;
  version: number;
  plan: string | null;
}

function toState(r: StateRow): TableState {
  const pending = r.plan ? (JSON.parse(r.plan) as Pending) : null;
  return { table: r.tbl, key: r.key, version: r.version, phase: pending ? "expanded" : "stable", pending };
}

function ensureStateTable(db: SqlDb): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS ${STATE} (tbl TEXT PRIMARY KEY, key TEXT NOT NULL, version INTEGER NOT NULL, plan TEXT)`,
  );
}

function readState(db: SqlDb, table: string): TableState | null {
  ensureStateTable(db);
  const [row] = db.prepare(`SELECT tbl, key, version, plan FROM ${STATE} WHERE tbl = ?`).all(table) as StateRow[];
  return row ? toState(row) : null;
}

function requireState(db: SqlDb, table: string, phase: Phase): TableState {
  const state = readState(db, table);
  if (!state) throw new Error(`${table} is not adopted; run adopt first`);
  if (state.phase !== phase) throw new Error(`${table} is ${state.phase}, expected ${phase}`);
  return state;
}

function requirePending(db: SqlDb, table: string): Pending {
  const { pending } = requireState(db, table, "expanded");
  if (!pending) throw new Error(`${table} has no pending migration`);
  return pending;
}
