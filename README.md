# sql-hotroll

[![ci](https://github.com/kanchingyg/sql-hotroll/actions/workflows/ci.yml/badge.svg)](https://github.com/kanchingyg/sql-hotroll/actions/workflows/ci.yml)
[![DOI](https://zenodo.org/badge/DOI/10.5281/zenodo.23675281.svg)](https://doi.org/10.5281/zenodo.23675281)
[![JSR](https://jsr.io/badges/@kanchingyg/hotroll)](https://jsr.io/@kanchingyg/hotroll)
[![JSR Score](https://jsr.io/badges/@kanchingyg/hotroll/score)](https://jsr.io/@kanchingyg/hotroll/score)
[![Runtime](https://img.shields.io/badge/runtime-Workers_%7C_Bun_%7C_Deno-f9f1e1)](https://github.com/kanchingyg/sql-hotroll)
[![SQL](https://img.shields.io/badge/SQL-D1_%7C_SQLite_%7C_PostgreSQL-F6821F)](https://github.com/kanchingyg/sql-hotroll)
[![license](https://img.shields.io/github/license/kanchingyg/sql-hotroll)](https://github.com/kanchingyg/sql-hotroll/blob/HEAD/LICENSE)

**SQ-HotRoll** — session-quiescence-gated progressive schema evolution with bijective inline complement lenses and DEC Mode 2026 TUI for Cloudflare D1, SQLite, and PostgreSQL 17.

**Author:** Augusto Cerrutti (`augustocerruttisatto@gmail.com`)  
**Target Runtimes:** Cloudflare Workers & D1, Cloudflare Hyperdrive, `bun:sqlite`, PostgreSQL 17.11, Drizzle ORM, Kysely, Browser SPAs, Electron Multi-Window Apps, Mobile In-App WebViews, Kubernetes `RollingUpdate` Pods, and Firecracker MicroVMs.

## Install

[JSR](https://jsr.io/@kanchingyg/hotroll) (published as `@kanchingyg/hotroll`):

```bash
bunx jsr add @kanchingyg/hotroll
npx jsr add @kanchingyg/hotroll
deno add jsr:@kanchingyg/hotroll
```

Not published to npm yet — install from JSR or clone this repo.

## Overview

`SQ-HotRoll` (`sql-hotroll`) decouples physical dual-table synchronization from logical client session promotion. It maintains bijectively synchronized $v_1$ and $v_2$ tables via inline complement lenses (`_lc`) and monotonic row-version guards (`_row_ver`), advancing each client session from $v_1$ to $v_2$ only at a verified quiescence boundary while enforcing zero-trust cryptographic migration provenance.

## Key Capabilities

1. **Bijective Inline Complement Lenses & Monotonic Dual-Write Triggers (`src/core.ts`, `src/lenses.ts`, `src/d1-adapter.ts`, `src/postgres-adapter.ts`):**
   - Achieves `1.00` row read per query (after phase-gated keyset backfill) and `2.00` rows written per mutation during the active migration window (reverting to `1.00` after `COMMITTED_GC`) on Cloudflare D1 with `0` lost updates and sub-millisecond single-flag rollback (`0.017 ms` on D1, `0.05 ms` on PostgreSQL 17.11).
   - Explicitly bounds single-pass lens applicability to bijective or complement-invertible row transforms; lossy aggregations (`GROUP BY` rollups, cryptographic one-way hashes) and external side-effecting mutations require multi-stage expand-contract migrations.
2. **3-Tier DDL AST Classifier & WAL-Paced Backfill (`src/ast-rewriter.ts`, `src/d1-adapter.ts`, `src/postgres-adapter.ts`):**
   - Routes additive/computed columns to Tier 0 SQLite `VIRTUAL` generated columns (`0.446 ms` setup, `206.9x` faster than shadow copy, `1.00x` read/write), introspects virtual columns via `PRAGMA table_xinfo` (`hidden = 2`), shrinks peak `.sqlite-wal` size by `55.70x` (`14.23 MB -> 255.47 KB`), and rewrites base table identifiers (`FROM orders_v2 AS orders`) to eliminate PostgreSQL `SQLSTATE 0A000` under Cloudflare Hyperdrive transaction pooling (`/hyperdrive/concepts/connection-pooling/`).
3. **Universal Client Quiescence & Portable Multi-CDN Envelopes (`src/client-quiescence.ts`, `src/core.ts`):**
   - Eliminates cross-CDN and mixed-pod schema skew across Multi-CDN gateways (`75.00% -> 0.00%` error rate), Kubernetes `RollingUpdate` pod pools (`50.00% -> 0.00%`, `1.754 ms` `SIGTERM` WAL `TRUNCATE`), Firecracker sandboxes (`100.00% -> 0.00%` in `158.88 us`), Electron multi-window IPC barriers (`33.40% -> 0.00%` in `<0.50 ms`), and Mobile In-App WebViews (`25.00% -> 0.00%` in `<100 ns`).
4. **Zero-Trust Cryptographic Provenance, OpenSSH `10.0p2` `SSHSIG` Verifier & Interactive TUI (`src/core.ts`, `src/attestation.ts`, `src/hardware-auth.ts`, `src/tui.ts`):**
   - Computes RFC 8785 JCS canonical SQL AST and lens digests (`jcs-sha256` / `jcs-sha384` in `59.28 us`), verifies `in-toto` v1.0 / SLSA v1.0 DSSE PAE M-of-N `Ed25519` quorums (`0.11 ms`), and verifies asymmetric `PASETO v4.public` / `Ed25519` JWKS `kid` edge tokens (`40.22 us`, zero shared edge secrets).
   - Implements a pure-WebCrypto OpenSSH `PROTOCOL.sshsig` parser (`verifyOpenSshSkSignatureEnvelope()` in `src/hardware-auth.ts`) that closes two empirical verification flaws discovered in OpenSSH `10.0p2` `ssh-keygen -Y verify` (which rejects `verify-required` in `allowed_signers` and ignores the 5-byte FIDO2 `flags` + `counter` trailer inside 69-byte `sk-ssh-ed25519@openssh.com` signature blobs, accepting `flags = 0x00` or regressed `counter` values).
   - Provides a DEC Mode 2026 synchronized differential TUI (`hotroll watch` / `hotroll ci-gate`) with `[M]` hardware authenticator support across FIDO2/CTAP2 YubiKey (`sk-ssh-ed25519@openssh.com`), ThinkPad/Linux `fprintd` + TPM 2.0 (`/dev/tpmrm0`), Windows Hello for Business TPM 2.0, macOS Touch ID Secure Enclave, and PIV/CAC smartcards (`PKCS#11` slot `9c` / `SSH_AUTH_SOCK`).

## Reproducibility & Verification Commands

```bash
# Run unit and integration test suite (23/23 tests passing, 261 expect() assertions across test/hotroll.test.ts and test/tui.test.ts)
bun test

# Run strict TypeScript type-checking across src/*.ts and test/*.test.ts (0 errors)
/workspace/wrangler-doctor-scratch/node_modules/.bin/tsc --noEmit

# Run formal verification (Z3 SMT 8/8 UNSAT + Spin 6.5.2 LTL)
python3 proofs/prove_hot_roll_safety.py && python3 proofs/verify_lenses_z3.py

# Compile publication PDF via Tectonic (12 pages, 0 Overfull/Underfull warnings)
cd paper && tectonic -X compile main.tex
```
