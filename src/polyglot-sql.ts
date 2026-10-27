/**
 * Compiled polyglot SQL lens DDL (`sql-hotroll/polyglot-sql`).
 * Emits SQLite WAL tables `files_v1` / `files_v2` with `_row_ver` + `_lc` and loop-free AFTER INSERT triggers.
 * @module
 */

export function compilePolyglotSqlSchema(): string {
  return `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;
CREATE TABLE IF NOT EXISTS files_v1 (
  id INTEGER PRIMARY KEY, full_name TEXT NOT NULL, blob_sha256 TEXT NOT NULL,
  byte_len INTEGER NOT NULL, _row_ver INTEGER NOT NULL DEFAULT 1, _lc TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS files_v2 (
  id INTEGER PRIMARY KEY, first_name TEXT NOT NULL, last_name TEXT NOT NULL,
  blob_sha256 TEXT NOT NULL, byte_len INTEGER NOT NULL, checksum_tag TEXT NOT NULL DEFAULT 'sha256-default',
  _row_ver INTEGER NOT NULL DEFAULT 1, _lc TEXT NOT NULL DEFAULT '{}'
);
CREATE TRIGGER IF NOT EXISTS trg_files_v1_ins AFTER INSERT ON files_v1
WHEN (SELECT COALESCE(_row_ver, -1) FROM files_v2 WHERE id = NEW.id) < NEW._row_ver BEGIN
  INSERT INTO files_v2 (id, first_name, last_name, blob_sha256, byte_len, checksum_tag, _row_ver, _lc)
  VALUES (NEW.id,
    CASE WHEN instr(NEW.full_name, ' ') > 0 THEN substr(NEW.full_name, 1, instr(NEW.full_name, ' ') - 1) ELSE NEW.full_name END,
    CASE WHEN instr(NEW.full_name, ' ') > 0 THEN substr(NEW.full_name, instr(NEW.full_name, ' ') + 1) ELSE '' END,
    NEW.blob_sha256, NEW.byte_len, COALESCE(json_extract(NEW._lc, '$.checksum_tag'), 'sha256-default'), NEW._row_ver, '{}')
  ON CONFLICT(id) DO UPDATE SET first_name=excluded.first_name, last_name=excluded.last_name,
    blob_sha256=excluded.blob_sha256, byte_len=excluded.byte_len,
    checksum_tag=COALESCE(json_extract(NEW._lc, '$.checksum_tag'), files_v2.checksum_tag), _row_ver=excluded._row_ver
  WHERE files_v2._row_ver < excluded._row_ver;
END;
CREATE TRIGGER IF NOT EXISTS trg_files_v2_ins AFTER INSERT ON files_v2
WHEN (SELECT COALESCE(_row_ver, -1) FROM files_v1 WHERE id = NEW.id) < NEW._row_ver BEGIN
  INSERT INTO files_v1 (id, full_name, blob_sha256, byte_len, _row_ver, _lc)
  VALUES (NEW.id, CASE WHEN NEW.last_name != '' THEN NEW.first_name || ' ' || NEW.last_name ELSE NEW.first_name END,
    NEW.blob_sha256, NEW.byte_len, NEW._row_ver, json_object('checksum_tag', NEW.checksum_tag))
  ON CONFLICT(id) DO UPDATE SET full_name=excluded.full_name, blob_sha256=excluded.blob_sha256,
    byte_len=excluded.byte_len, _row_ver=excluded._row_ver, _lc=excluded._lc
  WHERE files_v1._row_ver < excluded._row_ver;
END;
`.trim();
}
