-- Workaround 1 from the issue: bracket the rebuild with foreign_keys OFF/ON.
PRAGMA foreign_keys = OFF;
CREATE TABLE a_temp (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL DEFAULT ''
);
INSERT INTO a_temp (id, name) SELECT id, name FROM a;
DROP TABLE a;
ALTER TABLE a_temp RENAME TO a;
PRAGMA foreign_keys = ON;
