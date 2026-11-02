import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { discoverMigrations, type FileReport, formatReport, lintMigrations, type Mode } from "../src/lint/index.ts";
import { classify, splitStatements } from "../src/lint/sql.ts";

const FIXTURES = join(import.meta.dir, "fixtures");

async function lint(files: string[], mode: Mode = "d1"): Promise<FileReport[]> {
  return lintMigrations(
    files.map((sql, i) => ({ path: `${i}.sql`, sql })),
    { mode, rows: 3 },
  );
}

const rules = (r: FileReport | undefined) => r?.findings.map((f) => f.rule) ?? [];

function cli(...args: string[]) {
  const p = Bun.spawnSync(["bun", join(import.meta.dir, "../src/bin.ts"), ...args]);
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

const PARENT_CHILD = `
CREATE TABLE a (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE b (id INTEGER PRIMARY KEY, a_id INTEGER NOT NULL REFERENCES a (id) ON DELETE CASCADE);`;

const rebuildA = (prefix: string, select = "SELECT id, name FROM a") => `${prefix}
CREATE TABLE a_new (id INTEGER PRIMARY KEY, name TEXT);
INSERT INTO a_new (id, name) ${select};
DROP TABLE a;
ALTER TABLE a_new RENAME TO a;`;

describe("splitStatements", () => {
  test("keeps trigger bodies, CASE ... END, strings, and comments intact", () => {
    const src = [
      "-- header; not a statement",
      "CREATE TABLE t (s TEXT DEFAULT 'a;b'); /* c;",
      "d */ CREATE TRIGGER tr AFTER UPDATE ON t BEGIN",
      "  UPDATE t SET s = CASE WHEN 1 THEN 'x' END;",
      "  DELETE FROM t;",
      "END;",
      'DROP TABLE "main"."t";',
    ].join("\n");
    const stmts = splitStatements(src);
    expect(stmts.map((s) => s.line)).toEqual([2, 3, 7]);
    expect(stmts[1]?.code).toEndWith("END");
    expect(classify(stmts[2]?.code ?? "")).toEqual({ kind: "drop-table", table: "t" });
  });

  test("reads drizzle-kit statement breakpoints and quoted names", () => {
    const [copy, rename] = splitStatements(
      'INSERT INTO `__new_p`("id") SELECT "id" FROM `p`;--> statement-breakpoint\nALTER TABLE `__new_p` RENAME TO `p`;',
    );
    expect(classify(copy?.code ?? "")).toEqual({ kind: "copy", from: "p" });
    expect(classify(rename?.code ?? "")).toEqual({ kind: "rename-table", from: "__new_p", to: "p" });
  });
});

describe("fixtures", () => {
  test("workers-sdk-5438 exits 1 with CASCADE-LOSS", () => {
    const r = cli("lint", join(FIXTURES, "workers-sdk-5438/migrations"));
    expect(r.code).toBe(1);
    expect(r.out).toContain("CASCADE-LOSS");
    expect(r.out).toContain('"b" lost 3 of 3 rows');
  });

  test("atlas-3317 exits 1 with CASCADE-LOSS on child_table", () => {
    const r = cli("lint", join(FIXTURES, "atlas-3317/migrations"), "--json");
    expect(r.code).toBe(1);
    const report = JSON.parse(r.out) as { files: FileReport[] };
    expect(report.files[1]?.findings.find((f) => f.rule === "CASCADE-LOSS")?.message).toContain("child_table");
  });

  test("drizzle-clean (unmodified drizzle-kit 0.31.11 output) exits 0 with no findings", () => {
    const r = cli("lint", join(FIXTURES, "drizzle-clean/migrations"), "--strict", "--json");
    expect(r.code).toBe(0);
    const report = JSON.parse(r.out) as { files: FileReport[] };
    expect(report.files.map((f) => f.status)).toEqual(["OK", "OK", "OK"]);
  });

  test("drizzle-4938: a drizzle-kit table rebuild empties both children", async () => {
    const reports = await lintMigrations(discoverMigrations(join(FIXTURES, "drizzle-4938/migrations")), {
      mode: "d1",
      rows: 3,
    });
    const last = reports.at(-1);
    expect(last?.status).toBe("FAIL");
    expect(rules(last).filter((r) => r === "CASCADE-LOSS")).toHaveLength(2);
  });
});

describe("dynamic engine", () => {
  test("defer_foreign_keys does not stop the cascade (verified on wrangler 4.156.2 --local)", async () => {
    const [, r] = await lint([PARENT_CHILD, rebuildA("PRAGMA defer_foreign_keys = ON;")]);
    expect(rules(r)).toContain("CASCADE-LOSS");
    expect(rules(r)).not.toContain("DROP-PARENT-NO-DEFER");
  });

  test("foreign_keys = OFF works in sqlite mode, where statements run in autocommit", async () => {
    const [, r] = await lint([PARENT_CHILD, rebuildA("PRAGMA foreign_keys = OFF;")], "sqlite");
    expect(r?.status).toBe("OK");
  });

  test("a rebuild that copies fewer rows is ROW-LOSS on the rebuilt table", async () => {
    const [, r] = await lint([
      "CREATE TABLE a (id INTEGER PRIMARY KEY, name TEXT NOT NULL);",
      rebuildA("", "SELECT id, name FROM a WHERE id > 1"),
    ]);
    expect(r?.findings.find((f) => f.rule === "ROW-LOSS")?.message).toContain('"a" lost 1 of 3 rows');
  });

  test("ON DELETE SET NULL children are CASCADE-NULL", async () => {
    const [, r] = await lint([
      "CREATE TABLE a (id INTEGER PRIMARY KEY, name TEXT NOT NULL); CREATE TABLE c (id INTEGER PRIMARY KEY, a_id INTEGER REFERENCES a (id) ON DELETE SET NULL);",
      rebuildA("PRAGMA defer_foreign_keys = ON;"),
    ]);
    expect(rules(r)).toContain("CASCADE-NULL");
  });

  test("explicit DELETE is not reported as loss", async () => {
    const [, r] = await lint([PARENT_CHILD, "DELETE FROM b WHERE id = 1;"]);
    expect(r?.status).toBe("OK");
  });

  test("a table that cannot be seeded is UNSEEDED, never OK", async () => {
    const [, r] = await lint([
      "CREATE TABLE odd (id INTEGER PRIMARY KEY, code TEXT NOT NULL CHECK (code = 'magic'));",
      "ALTER TABLE odd ADD COLUMN note TEXT;",
    ]);
    expect(r?.status).toBe("UNSEEDED");
    expect(r?.findings[0]?.message).toContain("CHECK constraint failed");
  });

  test("a NOT NULL column without default fails once rows exist, and later files are SKIPPED", async () => {
    const [, bad, later] = await lint([
      "CREATE TABLE t (id INTEGER PRIMARY KEY);",
      "ALTER TABLE t ADD COLUMN must TEXT NOT NULL;",
      "CREATE TABLE u (id INTEGER PRIMARY KEY);",
    ]);
    expect(bad?.findings[0]?.rule).toBe("APPLY-FAIL");
    expect(bad?.findings[0]?.message).toContain("fails once tables have 3 rows each");
    expect(later?.status).toBe("SKIPPED");
  });
});

describe("static and schema rules", () => {
  test("DROP-NO-BACKUP for a dropped column and a dropped table", async () => {
    const [, r] = await lint([
      "CREATE TABLE t (id INTEGER PRIMARY KEY, old TEXT); CREATE TABLE gone (id INTEGER PRIMARY KEY);",
      "ALTER TABLE t DROP COLUMN old;\nDROP TABLE gone;",
    ]);
    expect(r?.findings.map((f) => [f.rule, f.line])).toEqual([
      ["DROP-NO-BACKUP", 1],
      ["DROP-NO-BACKUP", 2],
    ]);
  });

  test("TYPE-CHANGE and TRIGGER-LOST after a rebuild", async () => {
    const [, r] = await lint([
      "CREATE TABLE a (id INTEGER PRIMARY KEY, name TEXT NOT NULL); CREATE TABLE log (msg TEXT); CREATE TRIGGER a_log AFTER INSERT ON a BEGIN INSERT INTO log VALUES ('x'); END;",
      "CREATE TABLE a_new (id INTEGER PRIMARY KEY, name BLOB);\nINSERT INTO a_new SELECT id, name FROM a;\nDROP TABLE a;\nALTER TABLE a_new RENAME TO a;",
    ]);
    expect(r?.findings.map((f) => [f.rule, f.line])).toEqual([
      ["TRIGGER-LOST", 3],
      ["TYPE-CHANGE", 4],
    ]);
  });

  test("an explicit DROP TRIGGER is not TRIGGER-LOST", async () => {
    const [, r] = await lint([
      "CREATE TABLE a (id INTEGER PRIMARY KEY); CREATE TRIGGER t1 AFTER INSERT ON a BEGIN SELECT 1; END;",
      "DROP TRIGGER t1;",
    ]);
    expect(r?.status).toBe("OK");
  });
});

describe("output", () => {
  test("github annotations escape properties and data", () => {
    const out = formatReport(
      [
        {
          file: "m,1:x.sql",
          status: "FAIL",
          findings: [{ rule: "CASCADE-LOSS", severity: "error", line: 9, message: "50% lost\nnext" }],
        },
      ],
      "github",
    );
    expect(out).toBe("::error file=m%2C1%3Ax.sql,line=9,title=CASCADE-LOSS::50%25 lost%0Anext");
  });

  test("usage errors exit 2", () => {
    expect(cli("lint", "--mode", "remote").code).toBe(2);
    expect(cli("frobnicate").code).toBe(2);
  });
});
