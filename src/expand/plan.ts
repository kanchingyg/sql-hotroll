/**
 * Identifier and migration-plan types shared by the expand/contract engine and the CLI.
 *
 * @module
 */

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Empty is allowed: SQLite columns may have no declared type. */
const SQL_TYPE = /^([A-Za-z][A-Za-z0-9_ ]*(\(\s*\d+\s*(,\s*\d+\s*)?\))?)?$/;

export function ident(name: string): string {
  if (!IDENT.test(name)) throw new Error(`invalid SQL identifier: ${JSON.stringify(name)}`);
  return `"${name}"`;
}

export function sqlType(type: string): string {
  if (!SQL_TYPE.test(type)) throw new Error(`invalid column type: ${JSON.stringify(type)}`);
  return type;
}

/**
 * One schema change. `up` is a SQL expression over the old version's column names;
 * `down` is a SQL expression over the new version's column names. Expressions are
 * trusted input: they come from migration files, never from requests.
 */
export type Op =
  | { op: "add"; column: string; type: string; up: string }
  | { op: "drop"; column: string; down?: string }
  | { op: "rename"; from: string; to: string }
  | { op: "alter"; column: string; to?: string; type: string; up: string; down: string };

export interface Migration {
  table: string;
  /** INTEGER PRIMARY KEY column. Exposed unchanged in every version view. */
  key: string;
  from: number;
  to: number;
  ops: Op[];
}

/** Column that exists only in the old version, dropped at contract. */
export interface OldColumn {
  name: string;
  /** Value written when a row is written through the new view; NULL when absent. */
  down: string | null;
}

/** Column that exists only in the new version, stored under a temporary physical name. */
export interface NewColumn {
  name: string;
  physical: string;
  type: string;
  up: string;
}

export interface Layout {
  oldOnly: OldColumn[];
  newOnly: NewColumn[];
}

/** Turns ops into old-only and new-only physical columns. `typeOf` reads existing column types. */
export function resolveLayout(m: Migration, typeOf: (column: string) => string): Layout {
  if (!Number.isInteger(m.from) || !Number.isInteger(m.to) || m.to <= m.from) {
    throw new Error(`migration versions must be integers with to > from (got ${m.from} -> ${m.to})`);
  }
  const physical = (name: string) => `_hr${m.to}_${name}`;
  const oldOnly: OldColumn[] = [];
  const newOnly: NewColumn[] = [];
  for (const op of m.ops) {
    switch (op.op) {
      case "add":
        newOnly.push({ name: op.column, physical: physical(op.column), type: op.type, up: op.up });
        break;
      case "drop":
        oldOnly.push({ name: op.column, down: op.down ?? null });
        break;
      case "rename":
        oldOnly.push({ name: op.from, down: ident(op.to) });
        newOnly.push({ name: op.to, physical: physical(op.to), type: typeOf(op.from), up: ident(op.from) });
        break;
      case "alter": {
        const to = op.to ?? op.column;
        oldOnly.push({ name: op.column, down: op.down });
        newOnly.push({ name: to, physical: physical(to), type: op.type, up: op.up });
        break;
      }
      default: {
        const unknown: never = op;
        throw new Error(`unknown op ${JSON.stringify((unknown as { op?: unknown }).op)}`);
      }
    }
  }
  for (const c of newOnly) expression(c.up, `up for ${c.name}`);
  for (const c of oldOnly) if (c.down !== null) expression(c.down, `down for ${c.name}`);
  assertUnique(
    "old",
    oldOnly.map((c) => c.name),
  );
  assertUnique(
    "new",
    newOnly.map((c) => c.name),
  );
  const touched = [...oldOnly.map((c) => c.name), ...newOnly.map((c) => c.name)];
  if (touched.includes(m.key)) throw new Error(`key column ${m.key} cannot be changed by a migration`);
  for (const name of [m.table, m.key, ...touched]) ident(name);
  for (const c of newOnly) sqlType(c.type);
  return { oldOnly, newOnly };
}

function assertUnique(side: string, names: string[]): void {
  const dup = names.find((n, i) => names.indexOf(n) !== i);
  if (dup) throw new Error(`column ${dup} appears twice on the ${side} side of the migration`);
}

function expression(sql: unknown, what: string): void {
  if (typeof sql !== "string" || sql.trim() === "") throw new Error(`${what} must be a non-empty SQL expression`);
}
