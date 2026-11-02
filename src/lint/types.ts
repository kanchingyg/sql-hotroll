/**
 * Result types shared by the lint engine, its rules, and the reporters.
 *
 * @module
 */

/** How a migration file is applied. */
export type Mode =
  /** Each file runs inside one transaction, as `wrangler d1 migrations apply` does. */
  | "d1"
  /** Statements run one at a time in autocommit, as the `sqlite3` shell does. */
  | "sqlite";

export type Rule =
  | "CASCADE-LOSS"
  | "CASCADE-NULL"
  | "CASCADE-DELETE"
  | "ROW-LOSS"
  | "APPLY-FAIL"
  | "FK-ORPHAN"
  | "UNSEEDED"
  | "FK-PRAGMA-NOOP"
  | "DROP-PARENT-NO-DEFER"
  | "DROP-PARENT-CASCADE"
  | "DROP-NO-BACKUP"
  | "TYPE-CHANGE"
  | "TRIGGER-LOST";

export type Severity = "error" | "warning";

/** Errors mean rows are lost or the file does not apply; warnings mean a risk the run could not show. */
export const SEVERITY: Record<Rule, Severity> = {
  "CASCADE-LOSS": "error",
  "CASCADE-NULL": "error",
  "CASCADE-DELETE": "warning",
  "ROW-LOSS": "error",
  "APPLY-FAIL": "error",
  "FK-ORPHAN": "error",
  UNSEEDED: "warning",
  "FK-PRAGMA-NOOP": "warning",
  "DROP-PARENT-NO-DEFER": "warning",
  "DROP-PARENT-CASCADE": "warning",
  "DROP-NO-BACKUP": "warning",
  "TYPE-CHANGE": "warning",
  "TRIGGER-LOST": "warning",
};

export interface Finding {
  rule: Rule;
  severity: Severity;
  /** 1-based line in the migration file. */
  line: number;
  message: string;
  /** The child table a foreign key finding is about, so static and measured findings can be merged. */
  table?: string;
}

/** FAIL: an error. UNSEEDED: some table in scope had no rows, so data loss could not be checked. */
export type Status = "OK" | "WARN" | "UNSEEDED" | "FAIL" | "SKIPPED";

export interface FileReport {
  file: string;
  status: Status;
  findings: Finding[];
}

export function finding(rule: Rule, line: number, message: string, table?: string): Finding {
  return table === undefined
    ? { rule, severity: SEVERITY[rule], line, message }
    : { rule, severity: SEVERITY[rule], line, message, table };
}

export function statusOf(findings: Finding[]): Status {
  if (findings.some((f) => f.severity === "error")) return "FAIL";
  if (findings.some((f) => f.rule === "UNSEEDED")) return "UNSEEDED";
  return findings.length > 0 ? "WARN" : "OK";
}
