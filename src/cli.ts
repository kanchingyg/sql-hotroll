/**
 * The `sql-hotroll` command. Runs on Node 22.13+ (`node:sqlite`) and Bun (`bun:sqlite`).
 * Every command works on local files only; there is no remote database access.
 *
 * @module
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import pkg from "../package.json" with { type: "json" };
import type { Migration } from "./expand/plan.ts";
import { abort, adopt, backfill, contract, expand, pendingRows, status } from "./expand/sqlite.ts";
import {
  discoverMigrations,
  type FileReport,
  type Format,
  formatReport,
  lintMigrations,
  type MigrationSet,
  type Mode,
  PathError,
} from "./lint/index.ts";
import { openDatabase } from "./sqlite-driver.ts";

const USAGE = `sql-hotroll ${pkg.version}

Check migrations before they run:
  sql-hotroll lint [path]            a project (wrangler config or migrations/), a migrations folder,
                                     or one .sql file, linted after the files before it (default: .)
      --mode d1|sqlite               d1 (default): each file in one transaction, as wrangler applies it
                                     sqlite: statements in autocommit, as the sqlite3 shell applies them
      --format text|json|github      github prints Actions annotations; --json is short for --format json
      --rows <n>                     synthetic rows per table (default 3)
      --strict                       exit 1 on warnings and UNSEEDED too

Expand/contract a live SQLite file (for D1, the file under .wrangler/state; never a remote database):
  sql-hotroll adopt     --db <file> --table <t> --key <id> [--schema-version 1]
  sql-hotroll expand    --db <file> --plan <migration.json>
  sql-hotroll backfill  --db <file> --table <t> [--batch 500] [--checkpoint]
  sql-hotroll contract  --db <file> --table <t>     after old sessions drain
  sql-hotroll abort     --db <file> --table <t>
  sql-hotroll status    --db <file>

Other: sql-hotroll --version | -v, sql-hotroll --help | -h

Exit codes: 0 ok, 1 findings or failure, 2 usage error.`;

class UsageError extends Error {}

const OPTIONS = {
  mode: { type: "string" },
  format: { type: "string" },
  json: { type: "boolean" },
  rows: { type: "string" },
  strict: { type: "boolean" },
  db: { type: "string" },
  table: { type: "string" },
  key: { type: "string" },
  "schema-version": { type: "string" },
  version: { type: "boolean", short: "v" },
  plan: { type: "string" },
  batch: { type: "string" },
  checkpoint: { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const;

type Values = ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>["values"];

export async function main(argv: string[]): Promise<number> {
  let parsed: { values: Values; positionals: string[] };
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
  const { values, positionals } = parsed;
  const [command, ...rest] = positionals;
  if (values.help || (!command && !values.version) || command === "help") {
    console.log(USAGE);
    return 0;
  }
  if (values.version || command === "version") {
    console.log(pkg.version);
    return 0;
  }
  if (command === "lint") return lint(rest[0] ?? ".", values);
  return migrate(command, values);
}

async function lint(path: string, v: Values): Promise<number> {
  const mode = oneOf<Mode>("mode", v.mode ?? "d1", ["d1", "sqlite"]);
  const format = v.json ? "json" : oneOf<Format>("format", v.format ?? "text", ["text", "json", "github"]);
  const rows = positiveInt("rows", v.rows ?? "3");
  let sets: MigrationSet[];
  try {
    sets = discoverMigrations(path);
  } catch (err) {
    if (err instanceof PathError) throw new UsageError(err.message);
    throw err;
  }
  if (sets.length === 0)
    throw new UsageError(`no .sql migrations found in ${path}, its wrangler config, or ${path}/migrations`);
  const reports: FileReport[] = [];
  for (const set of sets) reports.push(...(await lintMigrations(set.files, { mode, rows }, set.from)));
  const out = formatReport(reports, format);
  if (out) console.log(out);
  const failing = reports.some((r) => r.status === "FAIL" || (v.strict && r.status !== "OK"));
  return failing ? 1 : 0;
}

async function migrate(command: string, v: Values): Promise<number> {
  const commands = ["adopt", "expand", "backfill", "contract", "abort", "status"];
  if (!commands.includes(command)) throw new UsageError(`unknown command "${command}"`);
  const db = await openDatabase(required("db", v.db));
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  try {
    switch (command) {
      case "adopt":
        adopt(
          db,
          required("table", v.table),
          required("key", v.key),
          positiveInt("schema-version", v["schema-version"] ?? "1"),
        );
        break;
      case "expand":
        expand(db, JSON.parse(readFileSync(required("plan", v.plan), "utf8")) as Migration);
        break;
      case "backfill": {
        const table = required("table", v.table);
        const done = backfill(db, table, {
          batchSize: positiveInt("batch", v.batch ?? "500"),
          checkpoint: v.checkpoint === true,
        });
        console.log(JSON.stringify({ table, backfilled: done, pending: pendingRows(db, table) }));
        return 0;
      }
      case "contract":
        contract(db, required("table", v.table));
        break;
      case "abort":
        abort(db, required("table", v.table));
        break;
    }
    console.log(JSON.stringify(status(db), null, 2));
    return 0;
  } finally {
    db.close();
  }
}

function required(name: string, value: string | undefined): string {
  if (!value) throw new UsageError(`missing --${name}`);
  return value;
}

function positiveInt(name: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new UsageError(`--${name} must be a positive integer (got ${raw})`);
  return n;
}

function oneOf<T extends string>(name: string, raw: string, allowed: readonly T[]): T {
  if (!(allowed as readonly string[]).includes(raw)) {
    throw new UsageError(`--${name} must be one of ${allowed.join(", ")} (got ${raw})`);
  }
  return raw as T;
}

/** Runs the CLI and exits the process with its status code. */
export function run(argv: string[]): void {
  main(argv).then(
    (code) => process.exit(code),
    (err: unknown) => {
      const usage = err instanceof UsageError;
      console.error(`sql-hotroll: ${err instanceof Error ? err.message : String(err)}${usage ? `\n\n${USAGE}` : ""}`);
      process.exit(usage ? 2 : 1);
    },
  );
}
