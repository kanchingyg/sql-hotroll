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
import { copiedBefore, type FileFacts } from "./facts.ts";
import type { Snapshot } from "./schema.ts";
import { type Finding, finding, type Mode } from "./types.ts";

const OFF = new Set(["off", "0", "false", "no"]);
const ON = new Set(["on", "1", "true", "yes"]);

const FK_PRAGMA_NOOP =
  "PRAGMA foreign_keys = OFF does nothing here: D1 runs each migration file in one transaction and SQLite ignores this pragma inside a transaction. Foreign keys and ON DELETE actions stay on.";

/** Rules that read statements in order, tracking the foreign key pragmas as they change. */
export function staticRules(facts: FileFacts, before: Snapshot, mode: Mode): Finding[] {
  const findings: Finding[] = [];
  let enforced = true;
  let deferred = false;
  for (const { line, action: a } of facts.steps) {
    if (a.kind === "pragma" && a.name === "foreign_keys" && OFF.has(a.value)) {
      if (mode === "d1") findings.push(finding("FK-PRAGMA-NOOP", line, FK_PRAGMA_NOOP));
      else enforced = false;
    }
    if (a.kind === "pragma" && a.name === "defer_foreign_keys") deferred = ON.has(a.value);
    if ((a.kind !== "drop-table" && a.kind !== "drop-column") || !before.tables.has(a.table)) continue;
    const backedUp = copiedBefore(facts, a.table, line);
    if (a.kind === "drop-column") {
      if (!backedUp)
        findings.push(
          finding(
            "DROP-NO-BACKUP",
            line,
            `drops column "${a.table}"."${a.column}" and its values; no earlier statement in this file copies them.`,
          ),
        );
      continue;
    }
    const children = childrenOf(before, a.table);
    if (children.length > 0 && enforced && !deferred) {
      findings.push(
        finding(
          "DROP-PARENT-NO-DEFER",
          line,
          `drops "${a.table}", which ${children.map((n) => `"${n}"`).join(", ")} reference, without PRAGMA defer_foreign_keys = on first. Children with NO ACTION make the drop fail. Deferring avoids that failure but does not stop ON DELETE CASCADE or SET NULL.`,
        ),
      );
    }
    if (!backedUp)
      findings.push(
        finding(
          "DROP-NO-BACKUP",
          line,
          `drops table "${a.table}" and its rows; no earlier statement in this file copies them.`,
        ),
      );
  }
  return findings;
}

/** Tables other than `parent` with a foreign key to it. */
export function childrenOf(schema: Snapshot, parent: string): string[] {
  return [...schema.tables.values()]
    .filter((t) => t.name !== parent && t.foreignKeys.some((fk) => fk.parent === parent))
    .map((t) => t.name);
}

/** Column type changes and dropped triggers, found by comparing the schema before and after. */
export function schemaRules(facts: FileFacts, before: Snapshot, after: Snapshot): Finding[] {
  const findings: Finding[] = [];
  for (const [name, old] of before.tables) {
    const now = after.tables.get(name);
    if (!now) continue;
    for (const col of old.columns) {
      const next = now.columns.find((c) => c.name === col.name);
      if (!next || normalizeType(next.type) === normalizeType(col.type)) continue;
      findings.push(
        finding(
          "TYPE-CHANGE",
          facts.createdAt.get(name) ?? 1,
          `"${name}"."${col.name}" changes type from ${col.type || "(none)"} to ${next.type || "(none)"}. SQLite copies existing values as they are, without converting them.`,
        ),
      );
    }
  }
  for (const [trigger, table] of before.triggers) {
    if (after.triggers.has(trigger) || facts.droppedTriggers.has(trigger) || !after.tables.has(table)) continue;
    findings.push(
      finding(
        "TRIGGER-LOST",
        facts.droppedAt.get(table) ?? 1,
        `trigger "${trigger}" on "${table}" is gone after the migration. Dropping a table drops its triggers; recreate it after the rebuild.`,
      ),
    );
  }
  return findings;
}

const normalizeType = (type: string) => type.trim().replace(/\s+/g, " ").toUpperCase();
