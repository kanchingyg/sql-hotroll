// SQ-HotRoll Provider-Physics Native Rust Target (`testbeds/rust/src/main.rs`)
// Compiles zero-dependency via: rustc -O testbeds/rust/src/main.rs -lsqlite3 -o testbeds/rust/target_rust
// Reproduces sqlx#1250 / rusqlite statement-cache hazard vs SQ-HotRoll versioned stmt_v1 / stmt_v2 + _lc triggers.
use std::env;
use std::ffi::{CStr, CString};
use std::os::raw::{c_char, c_int, c_uint, c_void};
use std::ptr;

const SQLITE_OK: c_int = 0;
const SQLITE_ROW: c_int = 100;
const SQLITE_SCHEMA: c_int = 17;
const SQLITE_PREPARE_PERSISTENT: c_uint = 0x01;

#[link(name = "sqlite3")]
extern "C" {
    fn sqlite3_open(filename: *const c_char, pp_db: *mut *mut c_void) -> c_int;
    fn sqlite3_close(db: *mut c_void) -> c_int;
    fn sqlite3_exec(db: *mut c_void, sql: *const c_char, cb: *const c_void, arg: *mut c_void, err: *mut *mut c_char) -> c_int;
    fn sqlite3_prepare(db: *mut c_void, sql: *const c_char, n_byte: c_int, pp_stmt: *mut *mut c_void, tail: *mut *const c_char) -> c_int;
    fn sqlite3_prepare_v3(db: *mut c_void, sql: *const c_char, n_byte: c_int, flags: c_uint, pp_stmt: *mut *mut c_void, tail: *mut *const c_char) -> c_int;
    fn sqlite3_step(stmt: *mut c_void) -> c_int;
    fn sqlite3_reset(stmt: *mut c_void) -> c_int;
    fn sqlite3_finalize(stmt: *mut c_void) -> c_int;
    fn sqlite3_column_text(stmt: *mut c_void, i_col: c_int) -> *const c_char;
    fn sqlite3_column_int(stmt: *mut c_void, i_col: c_int) -> c_int;
}

unsafe fn exec(db: *mut c_void, sql: &str) {
    let c_sql = CString::new(sql).unwrap();
    let rc = sqlite3_exec(db, c_sql.as_ptr(), ptr::null(), ptr::null_mut(), ptr::null_mut());
    assert_eq!(rc, SQLITE_OK, "SQLite exec failed: {}", sql);
}

fn main() {
    let db_path = env::args().nth(1).unwrap_or_else(|| ":memory:".to_string());
    let c_path = CString::new(db_path).unwrap();
    unsafe {
        let mut db: *mut c_void = ptr::null_mut();
        assert_eq!(sqlite3_open(c_path.as_ptr(), &mut db), SQLITE_OK);
        exec(db, "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;");

        // 1. Reproduce cached statement schema invalidation (SQLITE_SCHEMA = 17 / sqlx_s_1 cache trap)
        exec(db, "CREATE TEMP TABLE rust_naive (id INTEGER PRIMARY KEY, label TEXT); INSERT INTO rust_naive VALUES (1, 'v1');");
        let mut naive_stmt: *mut c_void = ptr::null_mut();
        let c_naive = CString::new("SELECT id, label FROM rust_naive WHERE id = 1;").unwrap();
        sqlite3_prepare(db, c_naive.as_ptr(), -1, &mut naive_stmt, ptr::null_mut());
        exec(db, "ALTER TABLE rust_naive ADD COLUMN tag TEXT DEFAULT 'v2';");
        let _step_rc = sqlite3_step(naive_stmt);
        let reset_rc = sqlite3_reset(naive_stmt);
        sqlite3_finalize(naive_stmt);

        // 2. SQ-HotRoll versioned statements (sqlx_s_v1, sqlx_s_v2) + bidirectional trigger _lc check
        exec(db, "INSERT INTO files_v2 (id, first_name, last_name, blob_sha256, byte_len, checksum_tag, _row_ver) VALUES (202, 'Grace', 'Hopper', 'cafebabe00112233445566778899aabb', 12288, 'sha256-rust-verified', 1) ON CONFLICT(id) DO UPDATE SET first_name=excluded.first_name, checksum_tag=excluded.checksum_tag, _row_ver=excluded._row_ver;");
        exec(db, "INSERT INTO files_v1 (id, full_name, blob_sha256, byte_len, _row_ver, _lc) VALUES (202, 'Admiral Hopper', 'cafebabe00112233445566778899aabb', 12288, 2, COALESCE((SELECT _lc FROM files_v1 WHERE id = 202), '{}')) ON CONFLICT(id) DO UPDATE SET full_name=excluded.full_name, _row_ver=excluded._row_ver, _lc=excluded._lc;");

        let mut stmt_v1: *mut c_void = ptr::null_mut();
        let mut stmt_v2: *mut c_void = ptr::null_mut();
        let q1 = CString::new("SELECT full_name, _lc FROM files_v1 WHERE id = 202;").unwrap();
        let q2 = CString::new("SELECT first_name, last_name, checksum_tag, _row_ver FROM files_v2 WHERE id = 202;").unwrap();
        sqlite3_prepare_v3(db, q1.as_ptr(), -1, SQLITE_PREPARE_PERSISTENT, &mut stmt_v1, ptr::null_mut());
        sqlite3_prepare_v3(db, q2.as_ptr(), -1, SQLITE_PREPARE_PERSISTENT, &mut stmt_v2, ptr::null_mut());

        let mut errors = 0;
        for _ in 0..20 {
            if sqlite3_step(stmt_v1) != SQLITE_ROW { errors += 1; }
            sqlite3_reset(stmt_v1);
            if sqlite3_step(stmt_v2) != SQLITE_ROW { errors += 1; }
            sqlite3_reset(stmt_v2);
        }

        sqlite3_step(stmt_v2);
        let first = CStr::from_ptr(sqlite3_column_text(stmt_v2, 0)).to_str().unwrap_or("");
        let last = CStr::from_ptr(sqlite3_column_text(stmt_v2, 1)).to_str().unwrap_or("");
        let chk = CStr::from_ptr(sqlite3_column_text(stmt_v2, 2)).to_str().unwrap_or("");
        let ver = sqlite3_column_int(stmt_v2, 3);
        let lc_ok = first == "Admiral" && last == "Hopper" && chk == "sha256-rust-verified" && ver == 2;
        sqlite3_reset(stmt_v2);

        sqlite3_finalize(stmt_v1);
        sqlite3_finalize(stmt_v2);
        sqlite3_close(db);

        println!(
            "{{\"lang\":\"rust\",\"driver\":\"rustc-sqlite3-ffi\",\"naive_reset_rc\":{},\"naive_sqlite_schema_17\":{},\"hotroll_execs\":40,\"hotroll_errors\":{},\"lc_preserved\":{}}}",
            reset_rc, reset_rc == SQLITE_SCHEMA, errors, lc_ok
        );
        std::process::exit(if reset_rc == SQLITE_SCHEMA && errors == 0 && lc_ok { 0 } else { 1 });
    }
}
