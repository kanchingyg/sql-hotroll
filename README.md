# sql-hotroll

[![ci](https://github.com/kanchingyg/sql-hotroll/actions/workflows/ci.yml/badge.svg)](https://github.com/kanchingyg/sql-hotroll/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/sql-hotroll)](https://www.npmjs.com/package/sql-hotroll)
[![JSR](https://jsr.io/badges/@kanchingyg/hotroll)](https://jsr.io/@kanchingyg/hotroll)
[![DOI](https://zenodo.org/badge/DOI/10.5281/zenodo.23682048.svg)](https://doi.org/10.5281/zenodo.23682048)
[![license](https://img.shields.io/github/license/kanchingyg/sql-hotroll)](https://github.com/kanchingyg/sql-hotroll/blob/HEAD/LICENSE)

`sql-hotroll lint` tells you, before you run a SQLite or Cloudflare D1 migration, whether it will silently delete rows. It applies your migration files to an in-memory database seeded with rows and counts what is left.

```text
 migrations/0002_rebuild_a.sql
 ┌─────────────────────────────┐      ┌───────────────────────────────────────┐
 │ PRAGMA foreign_keys = OFF;  │      │ in-memory SQLite, foreign keys on     │
 │ CREATE TABLE a_temp (...);  │ ───▶ │ 0001 applied, 3 rows seeded per table │
 │ INSERT INTO a_temp ...;     │      │ 0002 applied in one transaction (D1)  │
 │ DROP TABLE a;               │      │ a: 3 → 3 rows   b: 3 → 0 rows         │
 │ ALTER TABLE a_temp ...;     │      └───────────────────┬───────────────────┘
 └─────────────────────────────┘                          ▼
     9  error    CASCADE-LOSS   "b" lost 3 of 3 rows through ON DELETE CASCADE
                                when rows of "a" were removed.        exit 1
```

## Quickstart

The CLI is not in a release yet; npm `sql-hotroll@0.1.7` and JSR `@kanchingyg/hotroll@0.1.7` contain the library only. Until the next release, run it from a clone (Bun, or Node 22.13+ after `bun run build`):

```bash
git clone https://github.com/kanchingyg/sql-hotroll && cd sql-hotroll && bun install
bun src/bin.ts lint path/to/migrations          # wrangler layout: migrations/*.sql
bun src/bin.ts lint path/to/drizzle             # drizzle-kit: 0000_x.sql or <name>/migration.sql
```

After the release it becomes `npx sql-hotroll lint migrations` or `bunx sql-hotroll lint migrations`.

In GitHub Actions, `--format github` turns findings into annotations on the pull request:

```yaml
- run: bunx sql-hotroll lint migrations --format github
```

Nothing connects to a database. D1 is simulated locally; there is no remote mode.

## What it checks

For each migration file, in the order wrangler applies them: build the schema from the earlier files, seed every table with 3 rows that satisfy its foreign keys, apply the file, and compare.

| Rule | Level | Meaning |
|---|---|---|
| CASCADE-LOSS | error | A table lost rows through ON DELETE CASCADE when its parent was dropped or rebuilt |
| CASCADE-NULL | error | Foreign key values were set to NULL by ON DELETE SET NULL / SET DEFAULT |
| ROW-LOSS | error | A table lost rows that no DELETE in the file targets (for example a rebuild that copies fewer rows) |
| APPLY-FAIL | error | The file fails, and the report says whether it fails only once tables have rows |
| UNSEEDED | warning | A table the file touches could not be seeded (CHECK, virtual table, FK cycle), so loss there was not checked. Never reported as OK. |
| FK-PRAGMA-NOOP | warning | `PRAGMA foreign_keys = OFF` inside a D1 migration does nothing |
| DROP-PARENT-NO-DEFER | warning | Drops a table other tables reference, without `PRAGMA defer_foreign_keys = on` first |
| DROP-NO-BACKUP | warning | Drops a table or column whose data no earlier statement copies |
| TYPE-CHANGE | warning | A rebuild changes a column's declared type; existing values are not converted |
| TRIGGER-LOST | warning | A rebuild drops a table's triggers and does not recreate them |

Options: `--mode d1|sqlite`, `--format text|json|github` (`--json` for short), `--rows <n>`, `--strict` (exit 1 on warnings too). Exit codes: 0 clean, 1 findings at error level, 2 usage error.

### Why `PRAGMA foreign_keys = OFF` does not help on D1

- `wrangler d1 migrations apply` sends each file as one batch, and the batch runs in one transaction. Sources: [`buildMigrationQuery`](https://github.com/cloudflare/workers-sdk/blob/34f34b3dbf9ae70218115a4067f66565d184ed5e/packages/wrangler/src/d1/migrations/helpers.ts) and Miniflare's [`#txn`](https://github.com/cloudflare/workers-sdk/blob/34f34b3dbf9ae70218115a4067f66565d184ed5e/packages/miniflare/src/workers/d1/database.worker.ts).
- D1 runs every query in an implicit transaction, and user queries cannot change `PRAGMA foreign_keys` ([D1 docs: foreign keys](https://developers.cloudflare.com/d1/sql-api/foreign-keys/)).
- SQLite ignores `PRAGMA foreign_keys` inside a transaction ([pragma docs](https://www.sqlite.org/pragma.html#pragma_foreign_keys)).
- `PRAGMA defer_foreign_keys = on`, which D1 recommends, only delays the constraint check. ON DELETE CASCADE still runs.

I checked the last point with `wrangler 4.156.2 d1 migrations apply --local` on the `test/fixtures/workers-sdk-5438` files: every row of table `b` was deleted with either pragma. The fixtures reproduce [workers-sdk#5438](https://github.com/cloudflare/workers-sdk/issues/5438), [atlas#3317](https://github.com/ariga/atlas/issues/3317), and a drizzle-kit 0.31.11 table rebuild ([drizzle-orm#4938](https://github.com/drizzle-team/drizzle-orm/issues/4938)).

### Limits

- Seeded rows are synthetic. A migration whose effect depends on real values (a `WHERE` on a status column, say) can pass here and still lose data.
- Statement shapes (DROP TABLE, copies, renames) are read with patterns, not a full SQL parser. Row counts come from SQLite itself.
- The local SQLite version (Bun 3.53, Node 22: 3.50) differs from D1's. Features D1 rejects are not flagged.

## Expand/contract on a live SQLite file

The same binary also changes a table while old and new app versions both use it. Each version reads and writes through a view, `<table>_v<N>`, whose INSTEAD OF triggers keep both versions in sync.

```bash
sql-hotroll adopt    --db app.sqlite --table users --key id
sql-hotroll expand   --db app.sqlite --plan split-name.json   # add first_name/last_name, keep full_name
sql-hotroll backfill --db app.sqlite --table users
sql-hotroll contract --db app.sqlite --table users            # once no session uses users_v1
```

For D1 this works only on the local file under `.wrangler/state`. Updates through the old view recompute the new columns, which is correct only when `up(down(x)) = x`; upserts do not work on views.

## Research

The library modules (`src/core.ts`, `lenses.ts`, the D1 and PostgreSQL adapters, `client-quiescence.ts`) implement the system in the paper *Session-Quiescence-Gated Progressive Schema Evolution with Inline Complement Lenses* ([doi:10.5281/zenodo.23682048](https://doi.org/10.5281/zenodo.23682048), PDF in this repo). Clients move from schema v1 to v2 only at a safe point (page navigation, idle window, or explicit checkpoint), while triggers keep v1 and v2 tables in sync.

The paper's numbers come from local benchmark runs (in-process SQLite in WAL mode and PostgreSQL 17.11), not production. In 960 runs, TPC-C p99.9 latency was 49.9x lower on SQLite and 64.5x lower on PostgreSQL than a global cutover, with 0 of 1,200 requests failing versus 486 of 1,200. Z3 and Spin check nine safety properties of a model of the protocol, not of this TypeScript code.

The modules `attestation.ts`, `hardware-auth.ts` (FIDO2, TPM 2.0, OpenSSH SSHSIG), `tui.ts`, and `cdn-range-gate.ts`, and the Kubernetes and multi-CDN scenarios in `testbeds/`, are research prototypes exercised only by this repo's tests and simulations.

```bash
bun test                                                  # all tests
bunx tsc --noEmit                                         # typecheck (TypeScript 7)
python3 proofs/prove_hot_roll_safety.py && python3 proofs/verify_lenses_z3.py
```

## Development

```bash
bun install
bun run check      # biome on the CLI code, tsc --noEmit, bun test
bun run build      # dist/bin.js for Node; also runs on npm pack
```

## AI assistance

AI coding agents (Grok Bot and Cursor agents) wrote most of the code, tests, proof scripts, and documentation in this repository at the author's direction. The author chose the design, reviewed the output, and is responsible for it.

## License

MIT. Author: Augusto Cerrutti Satto (augustocerruttisatto@gmail.com), ORCID [0009-0005-7279-8319](https://orcid.org/0009-0005-7279-8319).
