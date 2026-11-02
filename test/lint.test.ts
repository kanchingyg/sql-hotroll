import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
    const [set] = discoverMigrations(join(FIXTURES, "drizzle-4938/migrations"));
    const reports = await lintMigrations(set?.files ?? [], { mode: "d1", rows: 3 });
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

  test("in sqlite mode, a cascade inside BEGIN gets the sqlite fix, not the D1 one", async () => {
    const [, r] = await lint([PARENT_CHILD, `BEGIN;\nPRAGMA foreign_keys = OFF;${rebuildA("")}\nCOMMIT;`], "sqlite");
    const loss = r?.findings.find((f) => f.rule === "CASCADE-LOSS");
    expect(loss?.message).toContain("before any BEGIN");
    expect(loss?.message).not.toContain("D1");
  });

  test("a copy after the drop is not a backup", async () => {
    const [, r] = await lint([
      "CREATE TABLE c (id INTEGER PRIMARY KEY, note TEXT);",
      "ALTER TABLE c DROP COLUMN note;\nCREATE TABLE c_copy AS SELECT * FROM c;",
    ]);
    expect(r?.findings.map((f) => [f.rule, f.line])).toEqual([["DROP-NO-BACKUP", 1]]);
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

describe("red team regressions", () => {
  const RT = join(FIXTURES, "red-team");
  const status = (dir: string) => {
    const r = cli("lint", join(RT, dir), "--json");
    const report = JSON.parse(r.out) as { files: FileReport[] };
    return { code: r.code, files: report.files };
  };

  test("B1: a NOT NULL failure mid-file is APPLY-FAIL at its line under Bun", () => {
    const { code, files } = status("notnull-mid");
    expect(code).toBe(1);
    expect(files[1]?.findings).toContainEqual(expect.objectContaining({ rule: "APPLY-FAIL", line: 2 }));
  });

  test("B1: dropping a parent with a NO ACTION child fails", () => {
    const { code, files } = status("noaction-drop-last");
    expect(code).toBe(1);
    expect(files[1]?.status).toBe("FAIL");
    expect(files[1]?.findings.map((f) => f.rule)).toContain("APPLY-FAIL");
  });

  test("B1: a comments-only file is OK and does not stop later files", () => {
    const { code, files } = status("comment-only");
    expect(code).toBe(0);
    expect(files.map((f) => f.status)).toEqual(["OK", "OK", "OK"]);
  });

  test("B2: a DELETE on the child does not hide the cascade", () => {
    const { code, files } = status("delete-hides-cascade");
    expect(code).toBe(1);
    expect(files[1]?.findings.find((f) => f.rule === "CASCADE-LOSS")?.message).toContain('"c" lost 3 of 3 rows');
  });

  test("B2: rows a DELETE removes itself are not loss, the rest of the cascade is", async () => {
    const [, r] = await lint([
      "CREATE TABLE p (id INTEGER PRIMARY KEY, note TEXT); CREATE TABLE c (id INTEGER PRIMARY KEY, p_id INTEGER NOT NULL REFERENCES p (id) ON DELETE CASCADE);",
      "DELETE FROM c WHERE id = 1;\nCREATE TABLE p_new (id INTEGER PRIMARY KEY, note TEXT);\nINSERT INTO p_new SELECT * FROM p;\nDROP TABLE p;\nALTER TABLE p_new RENAME TO p;",
    ]);
    expect(r?.findings.find((f) => f.rule === "CASCADE-LOSS")?.message).toContain('"c" lost 2 of 3 rows');
  });
});

describe("B3: dropping a referenced table, by the child's ON DELETE action", () => {
  const schema = (action: string) =>
    `CREATE TABLE p (id INTEGER PRIMARY KEY, note TEXT); CREATE TABLE c (id INTEGER PRIMARY KEY, p_id INTEGER REFERENCES p (id)${action});`;
  const rebuildP = (before: string, after = "") =>
    `${before}\nCREATE TABLE p_new (id INTEGER PRIMARY KEY, note TEXT);\nINSERT INTO p_new SELECT * FROM p;\nDROP TABLE p;\nALTER TABLE p_new RENAME TO p;\n${after}`;

  test("NO ACTION without defer: warning, and the file fails", async () => {
    const [, r] = await lint([schema(""), rebuildP("")]);
    expect(rules(r)).toEqual(expect.arrayContaining(["DROP-PARENT-NO-DEFER", "APPLY-FAIL"]));
    expect(r?.findings.find((f) => f.rule === "DROP-PARENT-NO-DEFER")?.message).toContain("foreign_key_check");
  });

  test("RESTRICT with defer on alone fails at COMMIT, and the warning says so", async () => {
    const [, r] = await lint([schema(" ON DELETE RESTRICT"), rebuildP("PRAGMA defer_foreign_keys = on;")]);
    expect(r?.findings.find((f) => f.rule === "APPLY-FAIL")?.message).toContain("at COMMIT");
    expect(r?.findings.find((f) => f.rule === "DROP-PARENT-NO-DEFER")?.message).toContain("alone does not help");
  });

  test("NO ACTION with defer on ... off: the rebuild is clean", async () => {
    const [, r] = await lint([
      schema(""),
      rebuildP("PRAGMA defer_foreign_keys = on;", "PRAGMA defer_foreign_keys = off;"),
    ]);
    expect(r?.findings).toEqual([]);
  });

  test("defer on ... off around a bare DROP leaves orphans: FK-ORPHAN", async () => {
    const [, r] = await lint([
      schema(""),
      "PRAGMA defer_foreign_keys = on;\nDROP TABLE p;\nPRAGMA defer_foreign_keys = off;",
    ]);
    expect(r?.status).toBe("FAIL");
    expect(rules(r)).toContain("FK-ORPHAN");
  });

  test("CASCADE and SET NULL children get DROP-PARENT-CASCADE, not the defer advice", async () => {
    const [, r] = await lint([schema(" ON DELETE CASCADE"), rebuildP("PRAGMA defer_foreign_keys = on;")]);
    expect(rules(r)).toEqual(expect.arrayContaining(["DROP-PARENT-CASCADE", "CASCADE-LOSS"]));
    expect(rules(r)).not.toContain("DROP-PARENT-NO-DEFER");
  });

  test("backing up the child and restoring it after the rebuild is clean", async () => {
    const [, r] = await lint([
      schema(" ON DELETE CASCADE"),
      rebuildP(
        "PRAGMA defer_foreign_keys = on;\nCREATE TABLE c_backup AS SELECT * FROM c;",
        "INSERT INTO c SELECT * FROM c_backup;\nDROP TABLE c_backup;\nPRAGMA defer_foreign_keys = off;",
      ),
    ]);
    expect(r?.findings).toEqual([]);
  });

  test("a rename-first rebuild leaves the child pointing at the old name: FK-ORPHAN", async () => {
    const [, r] = await lint([
      schema(""),
      "PRAGMA defer_foreign_keys = on;\nALTER TABLE p RENAME TO p_old;\nCREATE TABLE p (id INTEGER PRIMARY KEY, note TEXT);\nINSERT INTO p SELECT * FROM p_old;\nDROP TABLE p_old;\nPRAGMA defer_foreign_keys = off;",
    ]);
    expect(r?.findings.find((f) => f.rule === "FK-ORPHAN")?.message).toContain('"p_old", which does not exist');
  });

  test("sqlite mode: foreign_keys = OFF after BEGIN is FK-PRAGMA-NOOP", async () => {
    const [, r] = await lint(
      [schema(" ON DELETE CASCADE"), `BEGIN;\nPRAGMA foreign_keys = OFF;\n${rebuildP("")}COMMIT;`],
      "sqlite",
    );
    expect(r?.findings.find((f) => f.rule === "FK-PRAGMA-NOOP")?.line).toBe(2);
  });

  test("d1 mode: BEGIN in the file fails with the reason", async () => {
    const [, r] = await lint([schema(""), "BEGIN;\nCREATE TABLE z (id INTEGER);\nCOMMIT;"]);
    expect(r?.findings.find((f) => f.rule === "APPLY-FAIL")?.message).toContain("already runs each migration file");
  });
});

describe("B4: finding migrations", () => {
  const project = (files: Record<string, string>) => {
    const root = mkdtempSync(join(tmpdir(), "hotroll-lint-"));
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(join(root, rel, ".."), { recursive: true });
      writeFileSync(join(root, rel), text);
    }
    return root;
  };
  const init =
    "CREATE TABLE a (id INTEGER PRIMARY KEY, name TEXT NOT NULL);\nCREATE TABLE b (id INTEGER PRIMARY KEY, a_id INTEGER NOT NULL REFERENCES a (id) ON DELETE CASCADE);";
  const rebuild =
    "CREATE TABLE a_new (id INTEGER PRIMARY KEY, name TEXT);\nINSERT INTO a_new SELECT * FROM a;\nDROP TABLE a;\nALTER TABLE a_new RENAME TO a;";

  test("a fixture folder finds its migrations/ subfolder", () => {
    const r = cli("lint", join(FIXTURES, "workers-sdk-5438"));
    expect(r.code).toBe(1);
    expect(r.out).toContain("CASCADE-LOSS");
  });

  test("wrangler.toml migrations_dir", () => {
    const root = project({
      "wrangler.toml": '[[d1_databases]]\nbinding = "DB"\nmigrations_dir = "db/sql"\n',
      "db/sql/0001_init.sql": init,
      "db/sql/0002_rebuild.sql": rebuild,
    });
    expect(cli("lint", root).code).toBe(1);
  });

  test("wrangler.jsonc migrations_pattern for the drizzle folder layout, comments and trailing commas", () => {
    const root = project({
      "wrangler.jsonc":
        '{ // app\n "env": { "prod": { "d1_databases": [ { "binding": "DB", "migrations_dir": "drizzle", "migrations_pattern": "drizzle/*/migration.sql", }, ] } } }',
      "drizzle/0001_init/migration.sql": init,
      "drizzle/0002_rebuild/migration.sql": rebuild,
      "drizzle/0002_rebuild/snapshot.sql": "this is not a migration",
    });
    const r = cli("lint", root, "--json");
    expect(r.code).toBe(1);
    const report = JSON.parse(r.out) as { files: FileReport[] };
    expect(report.files.map((f) => f.file.split("/").slice(-2).join("/"))).toEqual([
      "0001_init/migration.sql",
      "0002_rebuild/migration.sql",
    ]);
  });

  test("one file is linted after the files before it", () => {
    const root = project({ "migrations/0001_init.sql": init, "migrations/0002_rebuild.sql": rebuild });
    const r = cli("lint", join(root, "migrations/0002_rebuild.sql"), "--json");
    const report = JSON.parse(r.out) as { files: FileReport[] };
    expect(report.files).toHaveLength(1);
    expect(report.files[0]?.findings.map((f) => f.rule)).toContain("CASCADE-LOSS");
  });

  test("a missing path is a usage error", () => {
    const r = cli("lint", "/nonexistent/hotroll");
    expect(r.code).toBe(2);
    expect(r.err).toContain("path not found");
  });

  test("--version and -v print the version", () => {
    expect(cli("--version").out.trim()).toMatch(/^\d+\.\d+\.\d+/);
    expect(cli("-v").code).toBe(0);
  });
});
