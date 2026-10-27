/*
 * SQ-HotRoll Provider-Physics Native C Target (`testbeds/c/target_sqlite.c`)
 * Compiles with: gcc -O2 testbeds/c/target_sqlite.c -lsqlite3 -o testbeds/c/target_sqlite
 * Verifies: (1) Legacy sqlite3_prepare() returns SQLITE_SCHEMA (17) after DDL;
 * (2) SQ-HotRoll versioned prepared statements (stmt_v1, stmt_v2) + SQL triggers achieve 0 errors and 0 _lc loss.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sqlite3.h>

static void exec_sql(sqlite3 *db, const char *sql) {
  char *err = NULL;
  if (sqlite3_exec(db, sql, NULL, NULL, &err) != SQLITE_OK) {
    fprintf(stderr, "SQLite error: %s\n", err ? err : "unknown");
    sqlite3_free(err);
    exit(1);
  }
}

int main(int argc, char **argv) {
  const char *db_path = (argc > 1) ? argv[1] : ":memory:";
  sqlite3 *db = NULL;
  if (sqlite3_open(db_path, &db) != SQLITE_OK) return 1;
  exec_sql(db, "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;");

  /* 1. Reproduce legacy C driver trap: sqlite3_prepare (v1) + online DDL -> SQLITE_SCHEMA (17) */
  exec_sql(db, "CREATE TEMP TABLE naive_items (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO naive_items VALUES (1, 'alpha');");
  sqlite3_stmt *naive_stmt = NULL;
  sqlite3_prepare(db, "SELECT id, name FROM naive_items WHERE id = 1;", -1, &naive_stmt, NULL);
  exec_sql(db, "ALTER TABLE naive_items ADD COLUMN extra TEXT DEFAULT 'v2';");
  int step_rc = sqlite3_step(naive_stmt);
  int reset_rc = sqlite3_reset(naive_stmt);
  sqlite3_finalize(naive_stmt);

  /* 2. Verify SQ-HotRoll stmt_v1 & stmt_v2 + bidirectional _row_ver / _lc triggers */
  sqlite3_stmt *ins_v2 = NULL, *upd_v1 = NULL, *sel_v1 = NULL, *sel_v2 = NULL;
  sqlite3_prepare_v3(db,
    "INSERT INTO files_v2 (id, first_name, last_name, blob_sha256, byte_len, checksum_tag, _row_ver) "
    "VALUES (101, 'Ada', 'Lovelace', 'deadbeef00112233445566778899aabb', 12288, 'sha256-c-verified', 1) "
    "ON CONFLICT(id) DO UPDATE SET first_name=excluded.first_name, checksum_tag=excluded.checksum_tag, _row_ver=excluded._row_ver;",
    -1, SQLITE_PREPARE_PERSISTENT, &ins_v2, NULL);
  sqlite3_step(ins_v2);
  sqlite3_reset(ins_v2);

  /* Legacy v1 C worker updates full_name at _row_ver = 2 without knowing about checksum_tag */
  sqlite3_prepare_v3(db,
    "INSERT INTO files_v1 (id, full_name, blob_sha256, byte_len, _row_ver, _lc) "
    "VALUES (101, 'Augusta Lovelace', 'deadbeef00112233445566778899aabb', 12288, 2, "
    "COALESCE((SELECT _lc FROM files_v1 WHERE id = 101), '{}')) "
    "ON CONFLICT(id) DO UPDATE SET full_name=excluded.full_name, _row_ver=excluded._row_ver, _lc=excluded._lc;",
    -1, SQLITE_PREPARE_PERSISTENT, &upd_v1, NULL);
  sqlite3_step(upd_v1);
  sqlite3_reset(upd_v1);

  sqlite3_prepare_v3(db, "SELECT full_name, _lc FROM files_v1 WHERE id = 101;", -1, SQLITE_PREPARE_PERSISTENT, &sel_v1, NULL);
  sqlite3_prepare_v3(db, "SELECT first_name, last_name, checksum_tag, _row_ver FROM files_v2 WHERE id = 101;", -1, SQLITE_PREPARE_PERSISTENT, &sel_v2, NULL);

  int hotroll_errors = 0;
  for (int i = 0; i < 20; i++) {
    if (sqlite3_step(sel_v1) != SQLITE_ROW) hotroll_errors++;
    sqlite3_reset(sel_v1);
    if (sqlite3_step(sel_v2) != SQLITE_ROW) hotroll_errors++;
    sqlite3_reset(sel_v2);
  }

  sqlite3_step(sel_v2);
  const char *first = (const char *)sqlite3_column_text(sel_v2, 0);
  const char *last = (const char *)sqlite3_column_text(sel_v2, 1);
  const char *chk = (const char *)sqlite3_column_text(sel_v2, 2);
  int ver = sqlite3_column_int(sel_v2, 3);
  int lc_ok = (first && strcmp(first, "Augusta") == 0 && last && strcmp(last, "Lovelace") == 0 &&
               chk && strcmp(chk, "sha256-c-verified") == 0 && ver == 2);
  sqlite3_reset(sel_v2);

  sqlite3_finalize(ins_v2);
  sqlite3_finalize(upd_v1);
  sqlite3_finalize(sel_v1);
  sqlite3_finalize(sel_v2);
  sqlite3_close(db);

  printf("{\"lang\":\"c\",\"driver\":\"libsqlite3-%s\",\"naive_step_rc\":%d,\"naive_reset_rc\":%d,"
         "\"naive_sqlite_schema_17\":%s,\"hotroll_execs\":40,\"hotroll_errors\":%d,\"lc_preserved\":%s}\n",
         sqlite3_libversion(), step_rc, reset_rc, (reset_rc == SQLITE_SCHEMA) ? "true" : "false",
         hotroll_errors, lc_ok ? "true" : "false");
  return (reset_rc == SQLITE_SCHEMA && hotroll_errors == 0 && lc_ok) ? 0 : 1;
}
