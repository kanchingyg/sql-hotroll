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
import { DEFER_OFF } from "./rules.ts";
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

const REBUILD_FIX: Record<Mode, string> = {
  d1: "In D1 no pragma prevents this. Use ALTER TABLE ADD/RENAME/DROP COLUMN if they are enough; otherwise copy the child rows to a backup table before the drop and insert them back after the rename, in the same file.",
  sqlite:
    "Set PRAGMA foreign_keys = OFF before any BEGIN, or copy the child rows to a backup table before the drop and insert them back after the rename.",
};

/** How the file removed a parent's rows, which decides the rule and the advice for its children. */
type Removal =
  | { kind: "delete"; root: string }
  | { kind: "refill" }
  | { kind: "rebuild" }
  | { kind: "drop" }
  | { kind: "cascade" }
  | { kind: "implicit" };

function advice(removal: Removal, parent: string, child: string, mode: Mode): string {
  switch (removal.kind) {
    case "refill":
      return `The file re-inserted the "${parent}" rows; the "${child}" rows are gone. Update "${parent}" in place, or copy the "${child}" rows to a backup table before the DELETE and insert them back after.`;
    case "rebuild":
      return REBUILD_FIX[mode];
    case "drop":
      return `Dropping "${parent}" deletes these rows. If that is intended, delete them (or drop "${child}") first; if not, copy them to a backup table before the drop.`;
    case "cascade":
      return `"${parent}" itself lost rows through ON DELETE CASCADE; fixing that keeps these rows too.`;
    case "implicit":
      return `No DELETE or DROP of "${parent}" is in the file, so a statement removed its rows implicitly: INSERT OR REPLACE and REPLACE delete the conflicting row first. Use INSERT ... ON CONFLICT DO UPDATE instead.`;
    case "delete":
      return "";
  }
}

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
  // A DELETE whose rows the file puts back (a refresh) lost the children; only a net delete is intended.
  const refilled = (t: string) => after.tables.has(t) && rowCount(runs.real, t) >= (counts.rows.get(t) ?? Infinity);
  const deletedFrom = deletedOnlyTables(facts, before, byAction, refilled);
  const removal = (parent: string): Removal => {
    const root = deletedFrom.get(parent);
    if (root !== undefined) return { kind: "delete", root };
    if (facts.deletedAt.has(parent) && !facts.droppedAt.has(parent)) return { kind: "refill" };
    if (facts.droppedAt.has(parent)) return after.tables.has(parent) ? { kind: "rebuild" } : { kind: "drop" };
    return byAction.has(parent) ? { kind: "cascade" } : { kind: "implicit" };
  };
  const via = (parent: string, root: string) =>
    parent === root ? `deleting rows of "${parent}"` : `the cascade from "${root}" through "${parent}"`;
  for (const [table, missing] of byAction) {
    const fks = before.tables.get(table)?.foreignKeys ?? [];
    const cause =
      fks.find((fk) => fk.onDelete === "CASCADE" && fk.parent !== table && parentHit(fk.parent)) ??
      fks.find((fk) => fk.onDelete === "CASCADE");
    const line = (cause && removedAt(facts, cause.parent)) ?? 1;
    const of = `${missing} of ${counts.rows.get(table)} rows`;
    const how: Removal = cause ? removal(cause.parent) : { kind: "implicit" };
    const parent = cause?.parent ?? "a parent table";
    findings.push(
      how.kind === "delete"
        ? finding(
            "CASCADE-DELETE",
            line,
            `${via(parent, how.root)} also deletes ${of} of "${table}" through ON DELETE CASCADE. Intended? If not, delete or re-point the "${table}" rows first.`,
            table,
          )
        : finding(
            "CASCADE-LOSS",
            line,
            `"${table}" lost ${of} through ON DELETE CASCADE when rows of "${parent}" were removed. ${advice(how, parent, table, mode)}`,
            table,
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
    const line = (fk && removedAt(facts, fk.parent)) ?? 1;
    const what = `${control - real} of ${n} "${table}"."${column}" values through ON DELETE ${fk?.onDelete ?? "SET NULL"}`;
    const how: Removal = fk ? removal(fk.parent) : { kind: "implicit" };
    findings.push(
      how.kind === "delete"
        ? finding("CASCADE-DELETE", line, `${via(fk?.parent ?? "", how.root)} also clears ${what}. Intended?`, table)
        : finding("CASCADE-NULL", line, `lost ${what} when rows of "${fk?.parent}" were removed.`, table),
    );
  }
  return findings;
}

/**
 * Tables whose rows went only through the file's own DELETE statements, directly or through a
 * cascade from such a table, and never through a DROP, mapped to the table the DELETE named.
 * A table the file refilled after deleting from it is left out. Their cascades are intended, most likely.
 */
function deletedOnlyTables(
  facts: FileFacts,
  before: Snapshot,
  byAction: Map<string, number>,
  refilled: (table: string) => boolean,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const t of facts.deletedAt.keys()) if (!facts.droppedAt.has(t) && !refilled(t)) out.set(t, t);
  for (let grew = true; grew; ) {
    grew = false;
    for (const table of byAction.keys()) {
      if (out.has(table) || facts.droppedAt.has(table)) continue;
      const parents = (before.tables.get(table)?.foreignKeys ?? [])
        .map((fk) => fk.parent)
        .filter((p) => p !== table && (removedAt(facts, p) !== undefined || byAction.has(p)));
      const roots = new Set(parents.map((p) => out.get(p)));
      if (parents.length > 0 && !roots.has(undefined)) {
        out.set(table, [...roots][0] as string);
        grew = true;
      }
    }
  }
  return out;
}

/**
 * Foreign keys left pointing at nothing: rows `PRAGMA foreign_key_check` reports, and foreign
 * keys whose parent table no longer exists (a rename-first rebuild rewrites the child's FK to the
 * old name). In SQLite and `wrangler --local`, `PRAGMA defer_foreign_keys = off` discards pending
 * violations, so a file can commit with orphans even though foreign keys are on; the D1 docs say
 * remote D1 fails instead (not verified).
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
      const renamed = facts.steps.find(({ action: a }) => a.kind === "rename-table" && a.to === fk.parent);
      const why = renamed
        ? `Renaming a parent table rewrites its children's foreign keys to the new name, so rename the new table into place instead (create "x_new", copy, drop the old one, rename "x_new").`
        : `The file drops "${fk.parent}" and does not create it again.`;
      findings.push(
        finding(
          "FK-ORPHAN",
          renamed?.line ?? facts.droppedAt.get(fk.parent) ?? 1,
          `"${table.name}" references table "${fk.parent}", which does not exist after this migration. ${why}`,
          table.name,
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
        `${n} row(s) of "${table}" reference rows of "${parent}" that no longer exist. ${DEFER_OFF}`,
        table,
      ),
    );
  }
  return findings;
}
