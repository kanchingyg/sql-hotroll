Reproduces https://github.com/cloudflare/workers-sdk/issues/5438: rebuilding table `a`
(create, copy, drop, rename) deletes every row of `b`, which references `a` with
ON DELETE CASCADE. `PRAGMA foreign_keys = OFF` (workaround 1 in the issue) has no effect
because D1 runs the file in one transaction.

Expected: `sql-hotroll lint` exits 1 with CASCADE-LOSS on `b`.
