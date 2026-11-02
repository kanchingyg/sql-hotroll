/**
 * Dynamic data-loss check. For each migration file: build the schema from the files before it,
 * seed every table with synthetic rows, apply the file, and compare row counts per table.
 * A table that loses rows nobody deleted explicitly is CASCADE-LOSS (or ROW-LOSS when no
 * cascading foreign key explains it). A table that could not be seeded is UNSEEDED, never OK.
 *
 * @module
 */
import { openDatabase, type SqlDb } from "../sqlite-driver.ts";
import { copiedBefore, type FileFacts, factsOf, removedAt } from "./facts.ts";
import { childrenOf, schemaRules, staticRules } from "./rules.ts";
import { nonNullCount, rowCount, type Snapshot, snapshot } from "./schema.ts";
import { type SeedResult, seed } from "./seed.ts";
import { type FileReport, type Finding, finding, type Mode, statusOf } from "./types.ts";

export interface MigrationFile {
  /** Path shown in reports. */
  path: string;
  sql: string;
}

export interface LintOptions {
  mode: Mode;
  /** Synthetic rows per table. */
  rows: number;
}

/** Lints files in order. Once one fails to apply, later files are SKIPPED. */
export async function lintMigrations(files: MigrationFile[], opts: LintOptions): Promise<FileReport[]> {
  const reports: FileReport[] = [];
  let broken = false;
  for (const [i, file] of files.entries()) {
    if (broken) {
      reports.push({ file: file.path, status: "SKIPPED", findings: [] });
      continue;
    }
    const findings = await lintOne(files.slice(0, i), file, opts);
    broken = findings.some((f) => f.rule === "APPLY-FAIL");
    reports.push({ file: file.path, status: statusOf(findings), findings });
  }
  return reports;
}

async function lintOne(earlier: MigrationFile[], file: MigrationFile, opts: LintOptions): Promise<Finding[]> {
  const facts = factsOf(file.sql);
  const db = await replay(earlier, opts.mode);
  try {
    const before = snapshot(db);
    const seeded = seed(db, before, opts.rows);
    const findings = staticRules(facts, before, opts.mode);
    for (const [table, line] of tablesInScope(facts, before)) {
      const reason = seeded.get(table);
      if (reason)
        findings.push(
          finding("UNSEEDED", line, `could not seed "${table}" (${reason}), so data loss there was not checked.`),
        );
    }
    const counts = measure(db, before, seeded);
    const failure = tryApply(db, file.sql, opts.mode);
    if (failure === null) {
      const after = snapshot(db);
      findings.push(...lossRules(db, facts, before, after, counts, opts.mode), ...schemaRules(facts, before, after));
    } else {
      const empty = await replay(earlier, opts.mode);
      const when =
        tryApply(empty, file.sql, opts.mode) === null
          ? `once tables have ${opts.rows} rows each`
          : "on an empty database too";
      empty.close();
      findings.push(finding("APPLY-FAIL", 1, `${failure} (fails ${when}).`));
    }
    return findings.sort((a, b) => a.line - b.line);
  } finally {
    db.close();
  }
}

async function replay(files: MigrationFile[], mode: Mode): Promise<SqlDb> {
  const db = await openDatabase(":memory:");
  for (const f of files) {
    const failure = tryApply(db, f.sql, mode);
    if (failure !== null) throw new Error(`${f.path} no longer applies: ${failure}`);
  }
  return db;
}

/** Applies a file the way the target does. Returns the error message, or null on success. */
function tryApply(db: SqlDb, sql: string, mode: Mode): string | null {
  const inTransaction = mode === "d1";
  try {
    if (inTransaction) db.exec("BEGIN");
    db.exec(sql);
    if (inTransaction) db.exec("COMMIT");
    return null;
  } catch (err) {
    if (inTransaction) db.exec("ROLLBACK");
    return err instanceof Error ? err.message : String(err);
  }
}

/** Tables the file names, plus their foreign key descendants, each with the line to report it at. */
function tablesInScope(facts: FileFacts, before: Snapshot): Map<string, number> {
  const scope = new Map([...facts.namedAt].filter(([t]) => before.tables.has(t)));
  const queue = [...scope.keys()];
  for (let t = queue.shift(); t !== undefined; t = queue.shift()) {
    for (const child of childrenOf(before, t)) {
      if (scope.has(child)) continue;
      scope.set(child, scope.get(t) as number);
      queue.push(child);
    }
  }
  return scope;
}

interface Counts {
  rows: Map<string, number>;
  /** Non-null values per `table\0column` for FK columns with ON DELETE SET NULL / SET DEFAULT. */
  linked: Map<string, number>;
}

function measure(db: SqlDb, before: Snapshot, seeded: SeedResult): Counts {
  const counts: Counts = { rows: new Map(), linked: new Map() };
  for (const table of before.tables.values()) {
    if (seeded.get(table.name) !== null) continue;
    counts.rows.set(table.name, rowCount(db, table.name));
    for (const fk of table.foreignKeys) {
      if (fk.onDelete !== "SET NULL" && fk.onDelete !== "SET DEFAULT") continue;
      for (const col of fk.from) counts.linked.set(`${table.name}\0${col}`, nonNullCount(db, table.name, col));
    }
  }
  return counts;
}

const CASCADE_FIX: Record<Mode, (table: string, parent: string) => string> = {
  d1: (t, p) =>
    `In D1 neither PRAGMA foreign_keys = OFF nor defer_foreign_keys prevents this; copy "${t}" first or avoid rebuilding "${p}".`,
  sqlite: (t, p) => `Set PRAGMA foreign_keys = OFF before any BEGIN, or copy "${t}" first.`,
};

function lossRules(
  db: SqlDb,
  facts: FileFacts,
  before: Snapshot,
  after: Snapshot,
  counts: Counts,
  mode: Mode,
): Finding[] {
  const lost = new Map<string, number>();
  for (const [table, n] of counts.rows) {
    if (!after.tables.has(table) || facts.deletedAt.has(table)) continue;
    // A drop without an earlier copy is intentional and reported by DROP-NO-BACKUP.
    const dropped = facts.droppedAt.get(table);
    if (dropped !== undefined && !copiedBefore(facts, table, dropped)) continue;
    const now = rowCount(db, table);
    if (now < n) lost.set(table, n - now);
  }
  const parentLost = (parent: string) => removedAt(facts, parent) !== undefined || lost.has(parent);
  const findings: Finding[] = [];
  for (const [table, missing] of lost) {
    const total = counts.rows.get(table) as number;
    const cause = before.tables
      .get(table)
      ?.foreignKeys.find((fk) => fk.onDelete === "CASCADE" && fk.parent !== table && parentLost(fk.parent));
    if (!cause) {
      findings.push(
        finding(
          "ROW-LOSS",
          facts.droppedAt.get(table) ?? 1,
          `"${table}" lost ${missing} of ${total} rows, and no DELETE in this file targets it.`,
        ),
      );
      continue;
    }
    findings.push(
      finding(
        "CASCADE-LOSS",
        removedAt(facts, cause.parent) ?? facts.droppedAt.get(table) ?? 1,
        `"${table}" lost ${missing} of ${total} rows through ON DELETE CASCADE when rows of "${cause.parent}" were removed. ${CASCADE_FIX[mode](table, cause.parent)}`,
      ),
    );
  }
  for (const [key, n] of counts.linked) {
    const [table, column] = key.split("\0") as [string, string];
    // Rows that are gone entirely are reported above; an UPDATE may null the column on purpose.
    if (lost.has(table) || facts.updated.has(table)) continue;
    if (!after.tables.get(table)?.columns.some((c) => c.name === column)) continue;
    const fk = before.tables.get(table)?.foreignKeys.find((f) => f.from.includes(column));
    if (!fk || !parentLost(fk.parent)) continue;
    const now = nonNullCount(db, table, column);
    if (now >= n) continue;
    findings.push(
      finding(
        "CASCADE-NULL",
        removedAt(facts, fk.parent) ?? 1,
        `"${table}"."${column}" lost ${n - now} of ${n} values through ON DELETE ${fk.onDelete} when rows of "${fk.parent}" were removed.`,
      ),
    );
  }
  return findings;
}
