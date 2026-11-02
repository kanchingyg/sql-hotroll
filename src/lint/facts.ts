/**
 * What a migration file does, indexed once from its statements so every rule reads the same answers.
 *
 * @module
 */
import { type Action, classify, type Statement, splitStatements } from "./sql.ts";

export interface Step extends Statement {
  action: Action;
}

export interface FileFacts {
  steps: Step[];
  /** First line whose statement names the table (as target, source, or rename side). */
  namedAt: Map<string, number>;
  droppedAt: Map<string, number>;
  deletedAt: Map<string, number>;
  /** First statement that copies rows out of the table. */
  copiedAt: Map<string, number>;
  /** First CREATE TABLE of, or RENAME TO, the table. */
  createdAt: Map<string, number>;
  updated: Set<string>;
  droppedTriggers: Set<string>;
}

export function factsOf(sql: string): FileFacts {
  const steps = splitStatements(sql).map((s) => ({ ...s, action: classify(s.code) }));
  const f: FileFacts = {
    steps,
    namedAt: new Map(),
    droppedAt: new Map(),
    deletedAt: new Map(),
    copiedAt: new Map(),
    createdAt: new Map(),
    updated: new Set(),
    droppedTriggers: new Set(),
  };
  const first = (map: Map<string, number>, table: string, line: number) => {
    if (!map.has(table)) map.set(table, line);
  };
  for (const { line, action: a } of steps) {
    if ("table" in a) first(f.namedAt, a.table, line);
    switch (a.kind) {
      case "drop-table":
        first(f.droppedAt, a.table, line);
        break;
      case "delete":
        first(f.deletedAt, a.table, line);
        break;
      case "copy":
        first(f.namedAt, a.from, line);
        first(f.copiedAt, a.from, line);
        break;
      case "create-table":
        first(f.createdAt, a.table, line);
        break;
      case "rename-table":
        first(f.namedAt, a.from, line);
        first(f.createdAt, a.to, line);
        break;
      case "update":
        f.updated.add(a.table);
        break;
      case "drop-trigger":
        f.droppedTriggers.add(a.trigger);
        break;
    }
  }
  return f;
}

/** True when some statement before `line` copies the table's rows. */
export const copiedBefore = (f: FileFacts, table: string, line: number) => (f.copiedAt.get(table) ?? Infinity) < line;

/** First line that drops the table or deletes from it, if any. */
export function removedAt(f: FileFacts, table: string): number | undefined {
  const lines = [f.droppedAt.get(table), f.deletedAt.get(table)].filter((n) => n !== undefined);
  return lines.length > 0 ? Math.min(...lines) : undefined;
}
