/**
 * Applies a migration file one statement at a time, the way its target would, so a failure
 * points at the statement that caused it.
 *
 * @module
 */
import type { SqlDb } from "../sqlite-driver.ts";
import type { Step } from "./facts.ts";
import type { Mode } from "./types.ts";

export interface Applied {
  /** The statement that failed, or null when the whole file applied. */
  failure: { line: number; message: string } | null;
  /** Rows each DELETE statement removed directly, per table (foreign key actions excluded). */
  deleted: Map<string, number>;
}

/** In d1 mode the file runs inside one transaction, as `wrangler d1 migrations apply` sends it. */
export function applySteps(db: SqlDb, steps: Step[], mode: Mode): Applied {
  const deleted = new Map<string, number>();
  const fail = (line: number, message: string): Applied => {
    rollback(db);
    return { failure: { line, message }, deleted };
  };
  if (mode === "d1") db.exec("BEGIN");
  for (const step of steps) {
    if (mode === "d1" && (step.action.kind === "begin" || step.action.kind === "end-transaction")) {
      return fail(
        step.line,
        "D1 already runs each migration file in one transaction, so BEGIN, COMMIT and ROLLBACK in the file fail. Remove them.",
      );
    }
    try {
      const { changes } = db.prepare(step.sql).run();
      const a = step.action;
      if (a.kind === "delete") deleted.set(a.table, (deleted.get(a.table) ?? 0) + Number(changes));
    } catch (err) {
      return fail(step.line, messageOf(err));
    }
  }
  if (mode === "d1") {
    try {
      db.exec("COMMIT");
    } catch (err) {
      return fail(steps.at(-1)?.line ?? 1, `at COMMIT, after the last statement: ${messageOf(err)}`);
    }
  }
  return { failure: null, deleted };
}

function rollback(db: SqlDb): void {
  try {
    db.exec("ROLLBACK");
  } catch {
    // No transaction was open: sqlite mode outside an explicit BEGIN.
  }
}

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));
