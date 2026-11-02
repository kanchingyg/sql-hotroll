import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import type { Migration } from "../src/expand/plan.ts";
import { abort, adopt, backfill, contract, expand, pendingRows, status } from "../src/expand/sqlite.ts";
import type { SqlDb } from "../src/sqlite-driver.ts";

const split: Migration = {
  table: "users",
  key: "id",
  from: 1,
  to: 2,
  ops: [
    { op: "add", column: "first_name", type: "TEXT", up: "substr(full_name, 1, instr(full_name || ' ', ' ') - 1)" },
    { op: "add", column: "last_name", type: "TEXT", up: "trim(substr(full_name, instr(full_name || ' ', ' ')))" },
    { op: "drop", column: "full_name", down: "trim(first_name || ' ' || last_name)" },
    { op: "rename", from: "mail", to: "email" },
  ],
};

const drivers: [string, () => SqlDb][] = [
  ["bun:sqlite", () => new Database(":memory:")],
  ["node:sqlite", () => new (require("node:sqlite").DatabaseSync)(":memory:")],
];

for (const [driver, open] of drivers) {
  describe(driver, () => {
    let db: SqlDb;

    beforeEach(() => {
      db = open();
      db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, full_name TEXT, mail TEXT, age INTEGER)");
      db.exec(
        "INSERT INTO users (full_name, mail, age) VALUES ('Ada Lovelace', 'ada@x', 36), ('Alan Turing', 'alan@x', 41)",
      );
      adopt(db, "users", "id");
    });

    const rows = (sql: string) => db.prepare(sql).all();

    describe("adopt", () => {
      test("creates a pass-through view that accepts writes", () => {
        db.exec("INSERT INTO users_v1 (full_name, mail, age) VALUES ('Grace Hopper', 'grace@x', 85)");
        db.exec("UPDATE users_v1 SET age = 37 WHERE id = 1");
        expect(rows("SELECT full_name, age FROM users ORDER BY id")).toEqual([
          { full_name: "Ada Lovelace", age: 37 },
          { full_name: "Alan Turing", age: 41 },
          { full_name: "Grace Hopper", age: 85 },
        ]);
      });

      test("rejects a key that is not the INTEGER PRIMARY KEY", () => {
        db.exec("CREATE TABLE tags (name TEXT PRIMARY KEY)");
        expect(() => adopt(db, "tags", "name")).toThrow("INTEGER PRIMARY KEY");
      });
    });

    describe("expand", () => {
      test("serves both versions at once, and writes on either side show up on the other", () => {
        expand(db, split);
        backfill(db, "users");
        expect(rows("SELECT id, first_name, last_name, email, age FROM users_v2 ORDER BY id")).toEqual([
          { id: 1, first_name: "Ada", last_name: "Lovelace", email: "ada@x", age: 36 },
          { id: 2, first_name: "Alan", last_name: "Turing", email: "alan@x", age: 41 },
        ]);

        db.exec("INSERT INTO users_v1 (full_name, mail, age) VALUES ('Grace Hopper', 'grace@x', 85)");
        db.exec("INSERT INTO users_v2 (first_name, last_name, email, age) VALUES ('Edsger', 'Dijkstra', 'ewd@x', 72)");
        db.exec("UPDATE users_v2 SET last_name = 'King' WHERE id = 1");
        db.exec("UPDATE users_v1 SET mail = 'turing@x' WHERE id = 2");

        expect(rows("SELECT id, full_name, mail FROM users_v1 ORDER BY id")).toEqual([
          { id: 1, full_name: "Ada King", mail: "ada@x" },
          { id: 2, full_name: "Alan Turing", mail: "turing@x" },
          { id: 3, full_name: "Grace Hopper", mail: "grace@x" },
          { id: 4, full_name: "Edsger Dijkstra", mail: "ewd@x" },
        ]);
        expect(rows("SELECT id, first_name, last_name, email FROM users_v2 ORDER BY id")).toEqual([
          { id: 1, first_name: "Ada", last_name: "King", email: "ada@x" },
          { id: 2, first_name: "Alan", last_name: "Turing", email: "turing@x" },
          { id: 3, first_name: "Grace", last_name: "Hopper", email: "grace@x" },
          { id: 4, first_name: "Edsger", last_name: "Dijkstra", email: "ewd@x" },
        ]);
      });

      test("deletes through either view remove the row", () => {
        expand(db, split);
        db.exec("DELETE FROM users_v2 WHERE id = 1");
        db.exec("DELETE FROM users_v1 WHERE id = 2");
        expect(rows("SELECT count(*) AS n FROM users")).toEqual([{ n: 0 }]);
      });

      test("is atomic: a bad plan leaves the table and the v1 view untouched", () => {
        const bad: Migration = { ...split, ops: [...split.ops, { op: "drop", column: "missing" }] };
        expect(() => expand(db, bad)).toThrow("users.missing does not exist");
        expect(status(db)[0]?.phase).toBe("stable");
        expect(rows("SELECT count(*) AS n FROM users_v1")).toEqual([{ n: 2 }]);
      });

      test("rolls back the ALTERs when a trigger body does not compile", () => {
        const broken: Migration = { ...split, ops: [{ op: "add", column: "nick", type: "TEXT", up: "lower(" }] };
        expect(() => expand(db, broken)).toThrow();
        const cols = (db.prepare("SELECT name FROM pragma_table_xinfo('users')").all() as { name: string }[]).map(
          (c) => c.name,
        );
        expect(cols).toEqual(["id", "full_name", "mail", "age"]);
        expect(rows("SELECT name FROM sqlite_schema WHERE type = 'view'")).toEqual([{ name: "users_v1" }]);
      });

      test("rejects unsafe identifiers and versions out of order", () => {
        expect(() => expand(db, { ...split, ops: [{ op: "drop", column: 'x"; DROP TABLE users; --' }] })).toThrow(
          "invalid SQL identifier",
        );
        expect(() => expand(db, { ...split, from: 1, to: 1 })).toThrow("to > from");
        expect(() => expand(db, { ...split, from: 3, to: 4 })).toThrow("migration starts at v3");
      });

      test("rejects unknown ops and missing expressions from a JSON plan", () => {
        const fromJson = (ops: unknown) => JSON.parse(JSON.stringify({ ...split, ops })) as Migration;
        expect(() => expand(db, fromJson([{ op: "explode", column: "age" }]))).toThrow('unknown op "explode"');
        expect(() => expand(db, fromJson([{ op: "add", column: "nick", type: "TEXT" }]))).toThrow("up for nick");
      });

      test("refuses a second expand while one is pending", () => {
        expand(db, split);
        expect(() => expand(db, split)).toThrow("expected stable");
      });
    });

    describe("backfill", () => {
      test("skips rows already written through a view and works in small batches", () => {
        for (let i = 0; i < 25; i++) db.exec(`INSERT INTO users (full_name, mail) VALUES ('P${i} Q${i}', 'p${i}@x')`);
        expand(db, split);
        db.exec("UPDATE users_v2 SET first_name = 'Countess' WHERE id = 1");
        expect(pendingRows(db, "users")).toBe(26);
        expect(backfill(db, "users", { batchSize: 4, checkpoint: true })).toBe(26);
        expect(pendingRows(db, "users")).toBe(0);
        expect(rows("SELECT first_name FROM users_v2 WHERE id = 1")).toEqual([{ first_name: "Countess" }]);
      });

      test("rejects a non-positive batch size", () => {
        expand(db, split);
        expect(() => backfill(db, "users", { batchSize: 0 })).toThrow("positive integer");
      });
    });

    describe("contract and abort", () => {
      test("contract refuses while rows are not backfilled", () => {
        expand(db, split);
        expect(() => contract(db, "users")).toThrow("not backfilled");
      });

      test("contract leaves only the new shape, under final names", () => {
        expand(db, split);
        backfill(db, "users");
        contract(db, "users");
        const cols = (db.prepare("SELECT name FROM pragma_table_xinfo('users')").all() as { name: string }[]).map(
          (c) => c.name,
        );
        expect(cols.sort()).toEqual(["age", "email", "first_name", "id", "last_name"]);
        expect(rows("SELECT name FROM sqlite_schema WHERE type = 'view'")).toEqual([{ name: "users_v2" }]);
        db.exec("INSERT INTO users_v2 (first_name, last_name, email) VALUES ('Barbara', 'Liskov', 'bl@x')");
        expect(rows("SELECT first_name FROM users WHERE id = 3")).toEqual([{ first_name: "Barbara" }]);
        expect(status(db)).toEqual([{ table: "users", key: "id", version: 2, phase: "stable", pending: null }]);
      });

      test("abort restores v1 and keeps writes made through v2", () => {
        expand(db, split);
        db.exec("UPDATE users_v2 SET first_name = 'Augusta', last_name = 'Byron' WHERE id = 1");
        abort(db, "users");
        expect(rows("SELECT full_name FROM users_v1 WHERE id = 1")).toEqual([{ full_name: "Augusta Byron" }]);
        expect(rows("SELECT name FROM sqlite_schema WHERE type = 'view'")).toEqual([{ name: "users_v1" }]);
        expect(status(db)[0]?.phase).toBe("stable");
      });

      test("alter keeps the column name and changes its representation", () => {
        db.exec("CREATE TABLE orders (id INTEGER PRIMARY KEY, amount REAL)");
        db.exec("INSERT INTO orders (amount) VALUES (12.5)");
        adopt(db, "orders", "id");
        expand(db, {
          table: "orders",
          key: "id",
          from: 1,
          to: 2,
          ops: [
            {
              op: "alter",
              column: "amount",
              type: "INTEGER",
              up: "CAST(round(amount * 100) AS INTEGER)",
              down: "amount / 100.0",
            },
          ],
        });
        backfill(db, "orders");
        db.exec("INSERT INTO orders_v2 (amount) VALUES (199)");
        expect(rows("SELECT amount FROM orders_v1 ORDER BY id")).toEqual([{ amount: 12.5 }, { amount: 1.99 }]);
        contract(db, "orders");
        expect(rows("SELECT amount FROM orders_v2 ORDER BY id")).toEqual([{ amount: 1250 }, { amount: 199 }]);
      });

      test("generated columns stay readable and are never written", () => {
        db.exec(
          "CREATE TABLE items (id INTEGER PRIMARY KEY, qty INTEGER, price INTEGER, total INTEGER AS (qty * price) VIRTUAL)",
        );
        adopt(db, "items", "id");
        db.exec("INSERT INTO items_v1 (qty, price) VALUES (3, 5)");
        expect(rows("SELECT total FROM items_v1")).toEqual([{ total: 15 }]);
        expect(() =>
          expand(db, { table: "items", key: "id", from: 1, to: 2, ops: [{ op: "drop", column: "total" }] }),
        ).toThrow("generated column");
      });
    });
  });
}
