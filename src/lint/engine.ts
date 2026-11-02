/**
 * Dynamic data-loss check. For each migration file: build the schema from the files before it,
 * seed every table with synthetic rows, apply the file, and compare row counts per table.
 * A table that loses rows nobody deleted explicitly is CASCADE-LOSS (or ROW-LOSS when no
 * cascading foreign key explains it). A table that could not be seeded is UNSEEDED, never OK.
 *
 * @module
 */
import { openDatabase, type SqlDb } from "../sqlite-driver.ts";
import { childrenOf, type Step, schemaRules, staticRules } from "./rules.ts";
import { nonNullCount, rowCount, type Snapshot, snapshot } from "./schema.ts";
import { type SeedResult, seed } from "./seed.ts";
import { classify, splitStatements } from "./sql.ts";
import { type FileReport, type Finding, type Mode, statusOf } from "./types.ts";

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
  const steps: Step[] = splitStatements(file.sql).map((s) => ({ ...s, action: classify(s.code) }));
  const db = await replay(earlier, opts.mode);
  try {
    const before = snapshot(db);
    const seeded = seed(db, before, opts.rows);
    const findings = staticRules(steps, before, opts.mode);
    const scope = tablesInScope(steps, before);
    for (const table of scope) {
      const reason = seeded.get(table);
      if (reason) {
        findings.push({
          rule: "UNSEEDED",
          severity: "warning",
          line: firstMention(steps, table),
          message: `could not seed "${table}" (${reason}), so data loss there was not checked.`,
        });
      }
    }
    const counts = measure(db, before, seeded);
    const failure = tryApply(db, file.sql, opts.mode);
    if (failure !== null) {
      const empty = await replay(earlier, opts.mode);
      const alsoEmpty = tryApply(empty, file.sql, opts.mode) !== null;
      empty.close();
      findings.push({
        rule: "APPLY-FAIL",
        severity: "error",
        line: 1,
        message: `${failure} (${alsoEmpty ? "fails on an empty database too" : `fails once tables have ${opts.rows} rows each`}).`,
      });
      return sortByLine(findings);
    }
    const after = snapshot(db);
    findings.push(...lossRules(db, steps, before, after, counts), ...schemaRules(steps, before, after));
    return sortByLine(findings);
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
  try {
    if (mode === "sqlite") {
      db.exec(sql);
      return null;
    }
    db.exec("BEGIN");
    try {
      db.exec(sql);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/** Tables the file names, plus everything that can lose rows through their foreign keys. */
function tablesInScope(steps: Step[], before: Snapshot): string[] {
  const scope = new Set<string>();
  for (const { action: a } of steps) {
    if ("table" in a) scope.add(a.table);
    if (a.kind === "rename-table") scope.add(a.from);
    if (a.kind === "copy") scope.add(a.from);
  }
  const queue = [...scope];
  for (let t = queue.shift(); t !== undefined; t = queue.shift()) {
    for (const child of childrenOf(before, t)) {
      if (!scope.has(child)) {
        scope.add(child);
        queue.push(child);
      }
    }
  }
  return [...scope].filter((t) => before.tables.has(t)).sort();
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

function lossRules(db: SqlDb, steps: Step[], before: Snapshot, after: Snapshot, counts: Counts): Finding[] {
  const removedAt = new Map<string, number>();
  const copied = new Set<string>();
  const updated = new Set<string>();
  for (const s of steps) {
    const a = s.action;
    if ((a.kind === "drop-table" || a.kind === "delete") && !removedAt.has(a.table)) removedAt.set(a.table, s.line);
    if (a.kind === "copy") copied.add(a.from);
    if (a.kind === "update") updated.add(a.table);
  }
  const explicit = (t: string) => steps.some((s) => s.action.kind === "delete" && s.action.table === t);
  const lost = new Map<string, number>();
  for (const [table, n] of counts.rows) {
    if (!after.tables.has(table) || explicit(table)) continue;
    // A drop without a copy is intentional and reported by DROP-NO-BACKUP.
    if (removedAt.has(table) && !copied.has(table)) continue;
    const now = rowCount(db, table);
    if (now < n) lost.set(table, n - now);
  }
  const findings: Finding[] = [];
  for (const [table, missing] of lost) {
    const total = counts.rows.get(table) as number;
    const cause = (before.tables.get(table)?.foreignKeys ?? []).find(
      (fk) => fk.onDelete === "CASCADE" && fk.parent !== table && (removedAt.has(fk.parent) || lost.has(fk.parent)),
    );
    findings.push(
      cause
        ? {
            rule: "CASCADE-LOSS",
            severity: "error",
            line: removedAt.get(cause.parent) ?? removedAt.get(table) ?? 1,
            message: `"${table}" lost ${missing} of ${total} rows through ON DELETE CASCADE when rows of "${cause.parent}" were removed. In D1 neither PRAGMA foreign_keys = OFF nor defer_foreign_keys prevents this; copy "${table}" first or avoid rebuilding "${cause.parent}".`,
          }
        : {
            rule: "ROW-LOSS",
            severity: "error",
            line: removedAt.get(table) ?? 1,
            message: `"${table}" lost ${missing} of ${total} rows, and no DELETE in this file targets it.`,
          },
    );
  }
  for (const [key, n] of counts.linked) {
    const [table, column] = key.split("\0") as [string, string];
    // Rows that are gone entirely are already reported above.
    if (lost.has(table) || updated.has(table)) continue;
    if (!after.tables.get(table)?.columns.some((c) => c.name === column)) continue;
    const fk = before.tables.get(table)?.foreignKeys.find((f) => f.from.includes(column));
    if (!fk || !(removedAt.has(fk.parent) || lost.has(fk.parent))) continue;
    const now = nonNullCount(db, table, column);
    if (now >= n) continue;
    findings.push({
      rule: "CASCADE-NULL",
      severity: "error",
      line: removedAt.get(fk.parent) ?? 1,
      message: `"${table}"."${column}" lost ${n - now} of ${n} values through ON DELETE ${fk.onDelete} when rows of "${fk.parent}" were removed.`,
    });
  }
  return findings;
}

function firstMention(steps: Step[], table: string): number {
  return steps.find((s) => s.code.includes(table))?.line ?? 1;
}

const sortByLine = (findings: Finding[]) => findings.sort((a, b) => a.line - b.line);
