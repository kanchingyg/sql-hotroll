/**
 * Rules that compare row counts. Each file is applied twice to identically seeded databases:
 * once as the target does (foreign keys on), and once as a control run with
 * `PRAGMA foreign_keys = OFF` set before anything else. Rows present in the control run but
 * missing from the real one were removed by ON DELETE actions; rows missing from the control run
 * itself were removed by the file's own statements.
 *
 * @module
 */
import type { SqlDb } from "../sqlite-driver.ts";
import type { Applied } from "./apply.ts";
import { copiedBefore, type FileFacts, removedAt } from "./facts.ts";
import { nonNullCount, rowCount, type Snapshot } from "./schema.ts";
import type { SeedResult } from "./seed.ts";
import { type Finding, finding, type Mode } from "./types.ts";

/** Row and FK-value counts of the seeded tables, taken before the file runs. */
export interface Counts {
  rows: Map<string, number>;
  /** Non-null values per `table\0column` for FK columns with ON DELETE SET NULL / SET DEFAULT. */
  linked: Map<string, number>;
}

export function measure(db: SqlDb, before: Snapshot, seeded: SeedResult): Counts {
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

export interface Runs {
  real: SqlDb;
  control: SqlDb;
  /** What the control run's DELETE statements removed. */
  controlApplied: Applied;
}

const CASCADE_FIX: Record<Mode, string> = {
  d1: "In D1 no pragma prevents this. Use ALTER TABLE ADD/RENAME/DROP COLUMN if they are enough; otherwise copy the child rows to a backup table before the drop and insert them back after the rename, in the same file.",
  sqlite:
    "Set PRAGMA foreign_keys = OFF before any BEGIN, or copy the child rows to a backup table before the drop and insert them back after the rename.",
};

export function lossRules(
  runs: Runs,
  facts: FileFacts,
  before: Snapshot,
  after: Snapshot,
  counts: Counts,
  mode: Mode,
): Finding[] {
  const findings: Finding[] = [];
  const byAction = new Map<string, number>();
  for (const [table, n] of counts.rows) {
    if (!after.tables.has(table)) continue;
    const real = rowCount(runs.real, table);
    const control = rowCount(runs.control, table);
    if (real < control) byAction.set(table, control - real);
    // A drop without an earlier copy is intentional and reported by DROP-NO-BACKUP.
    const dropped = facts.droppedAt.get(table);
    if (dropped !== undefined && !copiedBefore(facts, table, dropped)) continue;
    const expected = n - (runs.controlApplied.deleted.get(table) ?? 0);
    if (control < expected) {
      findings.push(
        finding(
          "ROW-LOSS",
          dropped ?? facts.createdAt.get(table) ?? 1,
          `"${table}" lost ${expected - control} of ${n} rows that no DELETE in this file removed (for example a rebuild that copies fewer rows).`,
        ),
      );
    }
  }
  const parentHit = (parent: string) => removedAt(facts, parent) !== undefined || byAction.has(parent);
  for (const [table, missing] of byAction) {
    const fks = before.tables.get(table)?.foreignKeys ?? [];
    const cause =
      fks.find((fk) => fk.onDelete === "CASCADE" && fk.parent !== table && parentHit(fk.parent)) ??
      fks.find((fk) => fk.onDelete === "CASCADE");
    const parent = cause ? `"${cause.parent}"` : "a parent table";
    findings.push(
      finding(
        "CASCADE-LOSS",
        (cause && removedAt(facts, cause.parent)) ?? 1,
        `"${table}" lost ${missing} of ${counts.rows.get(table)} rows through ON DELETE CASCADE when rows of ${parent} were removed. ${CASCADE_FIX[mode]}`,
      ),
    );
  }
  for (const [key, n] of counts.linked) {
    const [table, column] = key.split("\0") as [string, string];
    // Rows that are gone entirely are reported above.
    if (byAction.has(table) || !after.tables.get(table)?.columns.some((c) => c.name === column)) continue;
    const real = nonNullCount(runs.real, table, column);
    const control = nonNullCount(runs.control, table, column);
    if (real >= control) continue;
    const fk = before.tables.get(table)?.foreignKeys.find((f) => f.from.includes(column));
    findings.push(
      finding(
        "CASCADE-NULL",
        (fk && removedAt(facts, fk.parent)) ?? 1,
        `"${table}"."${column}" lost ${control - real} of ${n} values through ON DELETE ${fk?.onDelete ?? "SET NULL"} when rows of "${fk?.parent}" were removed.`,
      ),
    );
  }
  return findings;
}

/**
 * Foreign keys left pointing at nothing: rows `PRAGMA foreign_key_check` reports, and foreign
 * keys whose parent table no longer exists (a rename-first rebuild rewrites the child's FK to the
 * old name). `PRAGMA defer_foreign_keys = off` discards pending violations, so a file can commit
 * with orphans even though foreign keys are on.
 */
export function orphanRules(db: SqlDb, facts: FileFacts, before: Snapshot, after: Snapshot): Finding[] {
  const findings: Finding[] = [];
  const missingParent = new Set<string>();
  for (const table of after.tables.values()) {
    for (const fk of table.foreignKeys) {
      if (after.tables.has(fk.parent)) continue;
      const already = before.tables.get(table.name)?.foreignKeys.some((old) => old.parent === fk.parent);
      if (already && !before.tables.has(fk.parent)) continue;
      missingParent.add(`${table.name}\0${fk.parent}`);
      findings.push(
        finding(
          "FK-ORPHAN",
          facts.createdAt.get(fk.parent) ?? facts.droppedAt.get(fk.parent) ?? 1,
          `"${table.name}" now references table "${fk.parent}", which does not exist after this migration. Renaming a parent table rewrites its children's foreign keys to the new name.`,
        ),
      );
    }
  }
  const rows = db.prepare('SELECT "table" AS t, parent FROM pragma_foreign_key_check').all() as {
    t: string;
    parent: string;
  }[];
  const orphans = new Map<string, number>();
  for (const { t, parent } of rows) {
    const key = `${t}\0${parent}`;
    if (!missingParent.has(key)) orphans.set(key, (orphans.get(key) ?? 0) + 1);
  }
  for (const [key, n] of orphans) {
    const [table, parent] = key.split("\0") as [string, string];
    findings.push(
      finding(
        "FK-ORPHAN",
        removedAt(facts, parent) ?? 1,
        `${n} row(s) of "${table}" reference rows of "${parent}" that no longer exist. PRAGMA defer_foreign_keys = off discards pending violations, so the file commits anyway. Run PRAGMA foreign_key_check after the migration.`,
      ),
    );
  }
  return findings;
}
