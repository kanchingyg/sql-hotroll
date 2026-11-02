Repro cases from the Red Team audit of `feat/cli-lint` (`reviews/RED-TEAM-AUDIT-CLI-LINT.md`), kept as regression tests.

| Case | Expected |
|---|---|
| `notnull-mid` | FAIL: APPLY-FAIL at line 2 (NOT NULL). bun:sqlite's `exec` used to swallow this. |
| `noaction-drop-last` | FAIL: APPLY-FAIL, dropping a parent whose child has NO ACTION. |
| `comment-only` | OK: a file with only comments (the `drizzle-kit generate --custom` template). bun:sqlite used to throw on it. |
| `delete-hides-cascade` | FAIL: CASCADE-LOSS on `c`. A `DELETE FROM c WHERE 0` used to exempt `c` from the check. |
