/**
 * Statement-level rules. They read the migration text against the schema as it was before
 * the migration, so they also fire for tables that could not be seeded.
 *
 * Sources for the D1 behaviour these rules encode:
 * - D1 runs every query, including each migration file, inside an implicit transaction, and user
 *   queries cannot change `PRAGMA foreign_keys`; use `PRAGMA defer_foreign_keys` instead.
 *   https://developers.cloudflare.com/d1/sql-api/foreign-keys/
 * - `wrangler d1 migrations apply` sends each file, plus its row in `d1_migrations`, as one batch;
 *   locally Miniflare runs that batch in one storage transaction.
 *   workers-sdk@34f34b3 packages/wrangler/src/d1/migrations/helpers.ts (buildMigrationQuery),
 *   packages/miniflare/src/workers/d1/database.worker.ts (#txn)
 * - SQLite: "This pragma is a no-op within a transaction" (PRAGMA foreign_keys), and deferring
 *   only delays the constraint check; ON DELETE actions still run.
 *   https://www.sqlite.org/pragma.html#pragma_foreign_keys, https://www.sqlite.org/foreignkeys.html
 *
 * @module
 */
import type { Snapshot } from "./schema.ts";
import type { Action, Statement } from "./sql.ts";
import type { Finding, Mode } from "./types.ts";

const OFF = new Set(["off", "0", "false", "no"]);
const ON = new Set(["on", "1", "true", "yes"]);

export interface Step extends Statement {
  action: Action;
}

export function staticRules(steps: Step[], before: Snapshot, mode: Mode): Finding[] {
  const findings: Finding[] = [];
  let enforced = true;
  let deferred = false;
  const copied = new Set<string>();
  for (const step of steps) {
    const a = step.action;
    if (a.kind === "pragma" && a.name === "foreign_keys" && OFF.has(a.value)) {
      if (mode === "d1") {
        findings.push({
          rule: "FK-PRAGMA-NOOP",
          severity: "warning",
          line: step.line,
          message:
            "PRAGMA foreign_keys = OFF does nothing here: D1 runs each migration file in one transaction and SQLite ignores this pragma inside a transaction. Foreign keys and ON DELETE actions stay on.",
        });
      } else {
        enforced = false;
      }
    }
    if (a.kind === "pragma" && a.name === "defer_foreign_keys") deferred = ON.has(a.value);
    if (a.kind === "copy") copied.add(a.from);
    if (a.kind === "drop-table" && before.tables.has(a.table)) {
      const children = childrenOf(before, a.table);
      if (children.length > 0 && enforced && !deferred) {
        findings.push({
          rule: "DROP-PARENT-NO-DEFER",
          severity: "warning",
          line: step.line,
          message: `drops "${a.table}", which ${list(children)} reference, without PRAGMA defer_foreign_keys = on first. Children with NO ACTION make the drop fail. Deferring avoids that failure but does not stop ON DELETE CASCADE or SET NULL.`,
        });
      }
      if (!copied.has(a.table)) {
        findings.push({
          rule: "DROP-NO-BACKUP",
          severity: "warning",
          line: step.line,
          message: `drops table "${a.table}" and its rows; no earlier statement in this file copies them.`,
        });
      }
    }
    if (a.kind === "drop-column" && before.tables.has(a.table) && !copied.has(a.table)) {
      findings.push({
        rule: "DROP-NO-BACKUP",
        severity: "warning",
        line: step.line,
        message: `drops column "${a.table}"."${a.column}" and its values; no earlier statement in this file copies them.`,
      });
    }
  }
  return findings;
}

/** Tables other than `parent` with a foreign key to it. */
export function childrenOf(schema: Snapshot, parent: string): string[] {
  return [...schema.tables.values()]
    .filter((t) => t.name !== parent && t.foreignKeys.some((fk) => fk.parent === parent))
    .map((t) => t.name);
}

export function list(names: string[]): string {
  return names.map((n) => `"${n}"`).join(", ");
}

/** Column type changes and dropped triggers, found by comparing the schema before and after. */
export function schemaRules(steps: Step[], before: Snapshot, after: Snapshot): Finding[] {
  const findings: Finding[] = [];
  const recreatedAt = (table: string) =>
    steps.find(
      (s) =>
        (s.action.kind === "rename-table" && s.action.to === table) ||
        (s.action.kind === "create-table" && s.action.table === table),
    )?.line ?? 1;
  for (const [name, old] of before.tables) {
    const now = after.tables.get(name);
    if (!now) continue;
    for (const col of old.columns) {
      const next = now.columns.find((c) => c.name === col.name);
      if (next && normalizeType(next.type) !== normalizeType(col.type)) {
        findings.push({
          rule: "TYPE-CHANGE",
          severity: "warning",
          line: recreatedAt(name),
          message: `"${name}"."${col.name}" changes type from ${col.type || "(none)"} to ${next.type || "(none)"}. SQLite copies existing values as they are, without converting them.`,
        });
      }
    }
  }
  const droppedExplicitly = new Set(steps.flatMap((s) => (s.action.kind === "drop-trigger" ? [s.action.trigger] : [])));
  for (const [trigger, table] of before.triggers) {
    if (after.triggers.has(trigger) || droppedExplicitly.has(trigger) || !after.tables.has(table)) continue;
    const drop = steps.find((s) => s.action.kind === "drop-table" && s.action.table === table);
    findings.push({
      rule: "TRIGGER-LOST",
      severity: "warning",
      line: drop?.line ?? 1,
      message: `trigger "${trigger}" on "${table}" is gone after the migration. Dropping a table drops its triggers; recreate it after the rebuild.`,
    });
  }
  return findings;
}

const normalizeType = (type: string) => type.trim().replace(/\s+/g, " ").toUpperCase();
