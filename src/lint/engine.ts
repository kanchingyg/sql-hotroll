/**
 * Lints migration files in order. For each file: build the schema from the files before it, seed
 * every table with synthetic rows, run the static rules, then apply the file twice (see
 * `dynamic.ts`) and compare. A table that could not be seeded is UNSEEDED, never OK.
 *
 * @module
 */
import { openDatabase, type SqlDb } from "../sqlite-driver.ts";
import { applySteps } from "./apply.ts";
import { lossRules, measure, orphanRules } from "./dynamic.ts";
import { type FileFacts, factsOf } from "./facts.ts";
import { childrenOf, schemaRules, staticRules } from "./rules.ts";
import { type Snapshot, snapshot } from "./schema.ts";
import { type SeedResult, seed } from "./seed.ts";
import { type FileReport, type Finding, finding, type Mode, statusOf } from "./types.ts";

export interface MigrationFile {
  /** Path shown in reports. */
  path: string;
  sql: string;
}

export interface LintOptions {
  /** Default `"d1"`. */
  mode?: Mode;
  /** Synthetic rows per table. Default 3; 0 checks nothing. */
  rows?: number;
}

type Options = Required<LintOptions>;

/**
 * Lints `files` in order and reports on those from index `from` on (earlier files only build the
 * schema). Once one fails to apply, later files are SKIPPED.
 */
export async function lintMigrations(
  files: MigrationFile[],
  options: LintOptions = {},
  from = 0,
): Promise<FileReport[]> {
  const opts: Options = { mode: options.mode ?? "d1", rows: options.rows ?? 3 };
  const reports: FileReport[] = [];
  let broken = false;
  for (const [i, file] of files.entries()) {
    if (i < from) continue;
    if (broken) {
      reports.push({ file: file.path, status: "SKIPPED", findings: [] });
      continue;
    }
    const findings = await lintOne(files.slice(0, i), file, opts);
    broken = findings.some((f) => f.rule === "APPLY-FAIL");
    reports.push({ file: file.path, status: statusOf(findings), findings });
  }
  return reports;
}

interface Seeded {
  db: SqlDb;
  before: Snapshot;
  seeded: SeedResult;
}

async function seededAfter(earlier: MigrationFile[], opts: Options): Promise<Seeded> {
  const db = await replay(earlier, opts.mode);
  const before = snapshot(db);
  return { db, before, seeded: seed(db, before, opts.rows) };
}

async function lintOne(earlier: MigrationFile[], file: MigrationFile, opts: Options): Promise<Finding[]> {
  const facts = factsOf(file.sql);
  const { db, before, seeded } = await seededAfter(earlier, opts);
  let control: Seeded | undefined;
  try {
    control = await seededAfter(earlier, opts);
    const findings = staticRules(facts, before, opts.mode);
    for (const [table, line] of tablesInScope(facts, before)) {
      const reason = seeded.get(table);
      if (reason)
        findings.push(
          finding("UNSEEDED", line, `could not seed "${table}" (${reason}), so data loss there was not checked.`),
        );
    }
    const counts = measure(db, before, seeded);
    const { failure } = applySteps(db, facts.steps, opts.mode);
    if (failure) {
      findings.push(
        finding("APPLY-FAIL", failure.line, `${failure.message} (fails ${await failsWhen(earlier, facts, opts)}).`),
      );
      return merge(findings, new Set());
    }
    control.db.exec("PRAGMA foreign_keys = OFF");
    const controlApplied = applySteps(control.db, facts.steps, opts.mode);
    const after = snapshot(db);
    let measured = new Set<string>();
    if (controlApplied.failure === null) {
      const runs = { real: db, control: control.db, controlApplied };
      findings.push(...lossRules(runs, facts, before, after, counts, opts.mode));
      measured = new Set(counts.rows.keys());
    }
    findings.push(...orphanRules(db, facts, before, after), ...schemaRules(facts, before, after));
    return merge(findings, measured);
  } finally {
    db.close();
    control?.db.close();
  }
}

/** Whether a failing file also fails without seeded rows. */
async function failsWhen(earlier: MigrationFile[], facts: FileFacts, opts: Options): Promise<string> {
  const empty = await replay(earlier, opts.mode);
  try {
    return applySteps(empty, facts.steps, opts.mode).failure
      ? "on an empty database too"
      : `once tables have ${opts.rows} rows each`;
  } finally {
    empty.close();
  }
}

async function replay(files: MigrationFile[], mode: Mode): Promise<SqlDb> {
  const db = await openDatabase(":memory:");
  for (const f of files) {
    const { failure } = applySteps(db, factsOf(f.sql).steps, mode);
    if (failure) throw new Error(`${f.path}:${failure.line} no longer applies: ${failure.message}`);
  }
  return db;
}

/** Tables the file names, plus their foreign key descendants, each with the line to report it at. */
function tablesInScope(facts: FileFacts, before: Snapshot): Map<string, number> {
  const scope = new Map([...facts.namedAt].filter(([t]) => before.tables.has(t)));
  const queue = [...scope.keys()];
  for (let t = queue.shift(); t !== undefined; t = queue.shift()) {
    for (const child of childrenOf(before, t)) {
      if (scope.has(child)) continue;
      scope.set(child, scope.get(t) as number);
      queue.push(child);
    }
  }
  return scope;
}

/**
 * One finding per problem. A static warning about a child table gives way to what the run
 * measured for it: the measured finding when rows were lost, nothing when none were. A static
 * warning at the statement that failed to apply becomes the cause in the APPLY-FAIL message.
 * Of the findings left about one child at one line, only the most severe are kept.
 */
function merge(findings: Finding[], measured: Set<string>): Finding[] {
  const failLine = findings.find((f) => f.rule === "APPLY-FAIL")?.line;
  const causes = findings.filter((f) => f.rule === "DROP-PARENT-NO-DEFER" && f.line === failLine);
  const kept = findings
    .filter((f) => !causes.includes(f))
    .filter((f) => !(f.rule === "DROP-PARENT-CASCADE" && f.table !== undefined && measured.has(f.table)))
    .map((f) =>
      f.rule === "APPLY-FAIL" && causes.length > 0
        ? { ...f, message: [f.message, ...causes.map((c) => `Cause: ${c.message}`)].join(" ") }
        : f,
    );
  const worst = new Map<string, number>();
  const key = (f: Finding) => (f.table === undefined ? null : `${f.line}\0${f.table}`);
  const rank = (f: Finding) => (f.severity === "error" ? 1 : 0);
  for (const f of kept) {
    const k = key(f);
    if (k !== null) worst.set(k, Math.max(worst.get(k) ?? 0, rank(f)));
  }
  return kept
    .filter((f) => {
      const k = key(f);
      return k === null || rank(f) === worst.get(k);
    })
    .sort((a, b) => a.line - b.line);
}
