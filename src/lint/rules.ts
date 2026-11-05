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
  "PRAGMA foreign_keys = OFF does nothing here: it runs inside a transaction (D1 wraps each migration file in one), and SQLite ignores this pragma inside a transaction. Foreign keys and ON DELETE actions stay on.";

/** Foreign key state while reading a file top to bottom, as SQLite would track it. */
interface FkState {
  /** True inside a transaction. D1 files are always inside one. */
  inTransaction: boolean;
  /** False only after PRAGMA foreign_keys = OFF outside a transaction. */
  enforced: boolean;
  /** PRAGMA defer_foreign_keys; SQLite switches it off at every COMMIT or ROLLBACK. */
  deferred: boolean;
}

/** Rules that read statements in order, tracking the foreign key pragmas as they change. */
export function staticRules(facts: FileFacts, before: Snapshot, mode: Mode): Finding[] {
  const findings: Finding[] = [];
  const fk: FkState = { inTransaction: mode === "d1", enforced: true, deferred: false };
  for (const [i, { line, action: a }] of facts.steps.entries()) {
    if (a.kind === "begin") fk.inTransaction = true;
    if (a.kind === "end-transaction" && mode === "sqlite") Object.assign(fk, { inTransaction: false, deferred: false });
    if (a.kind === "pragma" && a.name === "foreign_keys" && OFF.has(a.value)) {
      if (fk.inTransaction) findings.push(finding("FK-PRAGMA-NOOP", line, FK_PRAGMA_NOOP));
      else fk.enforced = false;
    }
    if (a.kind === "pragma" && a.name === "foreign_keys" && ON.has(a.value) && !fk.inTransaction) fk.enforced = true;
    // Outside a transaction each statement commits on its own, which switches deferral back off.
    if (a.kind === "pragma" && a.name === "defer_foreign_keys") fk.deferred = fk.inTransaction && ON.has(a.value);
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
    if (fk.enforced) {
      const deferral = !fk.deferred ? "none" : laterDeferOff(facts, i) ? "on-off" : "on-only";
      findings.push(...dropParentRules(facts, before, { table: a.table, line }, deferral, mode));
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

const laterDeferOff = (facts: FileFacts, i: number) =>
  facts.steps
    .slice(i + 1)
    .some(({ action: a }) => a.kind === "pragma" && a.name === "defer_foreign_keys" && OFF.has(a.value));

/**
 * Dropping a referenced table deletes its rows first, so what happens depends on each child's
 * ON DELETE action. Children copied before the drop are being restored and are left out.
 */
function dropParentRules(
  facts: FileFacts,
  before: Snapshot,
  { table: parent, line }: { table: string; line: number },
  deferral: Deferral,
  mode: Mode,
): Finding[] {
  const findings: Finding[] = [];
  const children = [...before.tables.values()].flatMap((t) =>
    t.name === parent || copiedBefore(facts, t.name, line)
      ? []
      : t.foreignKeys.filter((k) => k.parent === parent).map((k) => ({ child: t.name, action: k.onDelete })),
  );
  const acting = children.filter((c) => ACTING.has(c.action));
  const blocking = children.filter((c) => !ACTING.has(c.action));
  const whatever =
    mode === "d1" ? "in D1 whatever pragmas the file sets" : "unless PRAGMA foreign_keys = OFF runs before any BEGIN";
  for (const child of acting) {
    findings.push(
      finding(
        "DROP-PARENT-CASCADE",
        line,
        `drops "${parent}"; ${describe([child])} will lose rows or foreign key values ${whatever}. Use ALTER TABLE ADD/RENAME/DROP COLUMN if they are enough; otherwise, in this same file, copy the children (and their own children) to a backup table before the drop and insert them back after the rename.`,
        child.child,
      ),
    );
  }
  if (blocking.length > 0 && deferral !== "on-off") {
    const advice =
      deferral === "on-only"
        ? `PRAGMA defer_foreign_keys = on alone does not help: SQLite counts the violations from the drop and fails the COMMIT even if the rebuild restores every key. Set it = off after the rebuild`
        : `Put PRAGMA defer_foreign_keys = on before the drop and = off once the replacement table is in place`;
    findings.push(
      finding(
        "DROP-PARENT-NO-DEFER",
        line,
        `drops "${parent}", which ${describe(blocking)} reference. ${advice}. ${DEFER_OFF}`,
      ),
    );
  }
  return findings;
}

/**
 * `defer_foreign_keys` around a drop: not on, on for the rest of the file (the COMMIT then fails
 * on the violations the drop counted), or on and switched off later (the counters reset).
 */
type Deferral = "none" | "on-only" | "on-off";

/** What `defer_foreign_keys = off` does with pending violations, hedged: remote D1 is untested. */
export const DEFER_OFF =
  "In SQLite and `wrangler --local`, setting it off discards pending violations and the file commits with orphans; the D1 docs say remote D1 fails instead (not verified). Either way, run PRAGMA foreign_key_check after migrating.";

/** ON DELETE actions that change child rows when the parent's rows go. */
const ACTING = new Set(["CASCADE", "SET NULL", "SET DEFAULT"]);

const describe = (children: { child: string; action: string }[]) =>
  children.map((c) => `"${c.child}" (ON DELETE ${c.action})`).join(", ");

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
