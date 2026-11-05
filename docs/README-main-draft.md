<!-- Draft README for main at 0.2.0, kept for reference. If feat/cli-lint is merged, its README.md replaces this file; review before use. -->

# sql-hotroll

[![ci](https://github.com/kanchingyg/sql-hotroll/actions/workflows/ci.yml/badge.svg)](https://github.com/kanchingyg/sql-hotroll/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/sql-hotroll)](https://www.npmjs.com/package/sql-hotroll)
[![JSR](https://jsr.io/badges/@kanchingyg/hotroll)](https://jsr.io/@kanchingyg/hotroll)
[![paper DOI](https://zenodo.org/badge/DOI/10.5281/zenodo.23675280.svg)](https://doi.org/10.5281/zenodo.23675280)
[![software DOI](https://zenodo.org/badge/DOI/10.5281/zenodo.23675682.svg)](https://doi.org/10.5281/zenodo.23675682)
[![license](https://img.shields.io/github/license/kanchingyg/sql-hotroll)](LICENSE)

A TypeScript library for changing a SQLite, Cloudflare D1, or PostgreSQL table while two versions of an application use it. Old and new columns are kept in sync by triggers generated from a lens (a pair of functions that map a row between versions), and each client moves to the new version only when it has no request in flight.

**Author:** Augusto Cerrutti Satto ([ORCID 0009-0005-7279-8319](https://orcid.org/0009-0005-7279-8319), augustocerruttisatto@gmail.com)

## Status

Research code, version 0.2.0. The API can change between minor versions.

## Quickstart: find data loss in a migration

```bash
npx sql-hotroll lint path/to/project   # Node 22.13+; or bunx sql-hotroll lint
```

`lint` replays each SQLite or D1 migration file on a seeded in-memory database, the way `wrangler d1 migrations apply` runs it (one transaction per file), and reports the line where rows are lost, for example through ON DELETE CASCADE. Nothing connects to a database.

## Install

```bash
npm install sql-hotroll          # npm
bunx jsr add @kanchingyg/hotroll # JSR
deno add jsr:@kanchingyg/hotroll
```

npm gets compiled JavaScript with `.d.ts` types, so every import below loads in Node 22.13+ and Bun; JSR gets the TypeScript sources for Deno. Cloudflare Workers are not tested. `sql-hotroll/d1-adapter` is written against `bun:sqlite`: given a file path it needs Bun; on other runtimes pass it a compatible database.

## Modules

| Import | Contents |
|---|---|
| `sql-hotroll/lint` | Finds data loss in SQLite and D1 migration files (also the `sql-hotroll lint` command) |
| `sql-hotroll/expand` | Expand/contract through versioned views on a SQLite file |
| `sql-hotroll/lenses` | Split/merge and rename lenses, and composition of lenses |
| `sql-hotroll/d1-adapter` | Trigger SQL for D1 and SQLite, batched backfill, introspection of generated columns (runs on a `bun:sqlite` database) |
| `sql-hotroll/postgres-adapter` | Trigger SQL for PostgreSQL and a check for DDL that takes heavy locks |
| `sql-hotroll/ast-rewriter` | Sorts a DDL change into tiers (generated column, view, copy) and rewrites table names per version |
| `sql-hotroll/client-quiescence` | Tracks in-flight requests per client and reports when a client can switch version |
| `sql-hotroll/core` | Version tokens and signed envelopes that carry a client's schema version |
| `sql-hotroll/attestation`, `/hardware-auth` | Signed migration approvals (in-toto / DSSE, Ed25519) and an OpenSSH `SSHSIG` verifier |
| `sql-hotroll/tui` | A terminal view of a running migration |

Only the adapters touch a database. Nothing here runs a migration for you; the calling code decides when to apply each step.

## Limits

- A lens works when the change can be undone row by row (`up(down(x)) = x`). Aggregations, one-way hashes, and changes with side effects outside the table need a multi-step expand/contract instead.
- D1 runs each migration file in one transaction, where `PRAGMA foreign_keys = OFF` has no effect. Rebuilding a table that other tables reference with ON DELETE CASCADE deletes their rows ([workers-sdk#5438](https://github.com/cloudflare/workers-sdk/issues/5438)).
- Measurements in the paper come from in-process SQLite in WAL mode and PostgreSQL 17.11 on one machine. They are not production numbers. The SQLite runs stand in for the engine D1 uses; neither D1 nor `wrangler --local` was measured.

## Paper and data

`SQ-HotRoll-Paper-01.pdf` describes the design and the measurements. Raw results are in `results/`, the benchmark harness in `harness/`, and the proof scripts in `proofs/`. Cite the paper through its concept DOI [10.5281/zenodo.23675280](https://doi.org/10.5281/zenodo.23675280) (all versions; the measurements described here are from v2, [10.5281/zenodo.23682048](https://doi.org/10.5281/zenodo.23682048)) and the code through [10.5281/zenodo.23675682](https://doi.org/10.5281/zenodo.23675682); [`CITATION.cff`](CITATION.cff) has both.

## Development

```bash
bun install
bun test
bunx tsc --noEmit
```

## AI assistance

AI coding agents wrote most of the code under my direction.

## License

MIT
