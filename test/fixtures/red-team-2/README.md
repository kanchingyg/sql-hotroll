Repro cases from the Red Team round 2 audit (`reviews/RED-TEAM-AUDIT-ROUND2.md`), kept as regression tests.

| Case | Expected |
|---|---|
| `trig-begin` | FAIL: CASCADE-LOSS. A column named `"begin"` in a trigger's WHEN clause used to hide the `DROP TABLE` after the trigger. |
| `trig-end` | OK. `SET "end" = 1` inside a trigger used to give a false APPLY-FAIL. |
| `b2-parent-delete` | WARN: CASCADE-DELETE. A DELETE of parent rows cascades on purpose; not an error. |
| `d1-tutorial-layout` | FAIL: CASCADE-LOSS. A loose `schema.sql` next to `migrations/` used to be linted instead of `migrations/`. |
| `toml-inline-array` | FAIL: CASCADE-LOSS. `d1_databases = [{ ... migrations_dir = "sql/m" }]` in wrangler.toml. |
