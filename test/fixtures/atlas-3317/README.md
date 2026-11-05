Reproduces https://github.com/ariga/atlas/issues/3317 (libSQL / Turso): making
`parent_table.description` nullable makes Atlas rebuild the table. Atlas wraps the file in a
transaction, so its `PRAGMA foreign_keys = off` is ignored and `child_table` is emptied through
ON DELETE CASCADE. Schema and data are from the issue; the migration follows the statement order
Atlas generates for a SQLite table rebuild.

Expected: `sql-hotroll lint` exits 1 with CASCADE-LOSS on `child_table`.
