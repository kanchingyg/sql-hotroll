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
  | "ROW-LOSS"
  | "APPLY-FAIL"
  | "UNSEEDED"
  | "FK-PRAGMA-NOOP"
  | "DROP-PARENT-NO-DEFER"
  | "DROP-NO-BACKUP"
  | "TYPE-CHANGE"
  | "TRIGGER-LOST";

export type Severity = "error" | "warning";

export interface Finding {
  rule: Rule;
  severity: Severity;
  /** 1-based line in the migration file. */
  line: number;
  message: string;
}

/** FAIL: an error. UNSEEDED: some table in scope had no rows, so data loss could not be checked. */
export type Status = "OK" | "WARN" | "UNSEEDED" | "FAIL" | "SKIPPED";

export interface FileReport {
  file: string;
  status: Status;
  findings: Finding[];
}

export function statusOf(findings: Finding[]): Status {
  if (findings.some((f) => f.severity === "error")) return "FAIL";
  if (findings.some((f) => f.rule === "UNSEEDED")) return "UNSEEDED";
  return findings.length > 0 ? "WARN" : "OK";
}
