/**
 * Portfolio Instrumentation Probes for Paper #1 (SQ-HotRoll)
 * Connects directly to Augusto Cerrutti's 5 open-source tools across Linux & Windows:
 *   1. wrangler-doctor (src/engines/cf-migrate-audit.ts)
 *   2. flaredump       (src/recorder-middleware.ts)
 *   3. dbwatch         (src/differ.ts)
 *   4. pg-lock-xray    (src/sql-analyzer.ts)
 *   5. pgcow           (src/cow-engine.ts)
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const PROBES_DIR = import.meta.dir;
const PROJECT_ROOT = path.resolve(PROBES_DIR, "../..");

function resolvePortfolioModule(candidates: string[]): string {
  for (const rel of candidates) {
    const abs = path.resolve(PROBES_DIR, rel);
    if (fs.existsSync(abs)) {
      return pathToFileURL(abs).href;
    }
  }
  throw new Error(
    `Could not locate portfolio module among candidates: ${candidates.join(", ")}`
  );
}

export async function runPortfolioProbes() {
  const pgLockXrayMod = await import(
    resolvePortfolioModule([
      "../../../../opensource/pg-lock-xray/src/sql-analyzer.ts",
      "../../../../audit-13/pg-lock-xray/src/sql-analyzer.ts",
    ])
  );
  const dbwatchMod = await import(
    resolvePortfolioModule([
      "../../../../opensource/dbwatch/src/differ.ts",
      "../../../../audit-13/dbwatch/src/differ.ts",
    ])
  );
  const pgcowMod = await import(
    resolvePortfolioModule([
      "../../../../opensource/pgcow/src/cow-engine.ts",
      "../../../../audit-13/pgcow/src/cow-engine.ts",
    ])
  );
  const flaredumpMod = await import(
    resolvePortfolioModule([
      "../../../../opensource/flaredump/src/recorder-middleware.ts",
      "../../../../audit-13/flaredump/src/recorder-middleware.ts",
    ])
  );
  const wranglerDoctorMod = await import(
    resolvePortfolioModule([
      "../../../../opensource/wrangler-doctor/src/engines/cf-migrate-audit.ts",
      "../../../../wrangler-doctor-scratch/src/engines/cf-migrate-audit.ts",
    ])
  );

  const { analyzeSqlText, buildFixPreview } = pgLockXrayMod;
  const { diffSnapshots } = dbwatchMod;
  const { cowCloneDir } = pgcowMod;
  const { withFlareDump } = flaredumpMod;
  const { checkCfMigrate } = wranglerDoctorMod;

  // 1. pg-lock-xray: Analyze B0 Stop-the-World DDL vs SQ-HotRoll non-blocking expand/contract DDL
  const b0Sql = [
    "CREATE INDEX idx_orders_customer ON orders (customer_id);",
    "ALTER TABLE orders ADD CONSTRAINT fk_orders_cust FOREIGN KEY (customer_id) REFERENCES customers (id);",
    "ALTER TABLE orders ADD COLUMN billing_meta JSONB NOT NULL DEFAULT now();",
  ].join("\n");
  const sqSql = [
    "SET lock_timeout = '2s';",
    "CREATE TABLE IF NOT EXISTS orders_v2 (id BIGINT PRIMARY KEY, first_name TEXT, last_name TEXT, billing_meta JSONB, _row_ver INT, _lc TEXT);",
    "CREATE INDEX CONCURRENTLY idx_orders_v2_customer ON orders_v2 (id);",
  ].join("\n");

  const xrayB0 = analyzeSqlText(b0Sql, "b0_stop_the_world.sql");
  const xraySq = analyzeSqlText(sqSql, "sq_hotroll_expand.sql");
  const fixPreview = buildFixPreview(b0Sql, "b0_stop_the_world.sql");

  // 2. dbwatch: Snapshot diffing across v1 and v2 dual-table state
  const snapBefore = {
    orders_v1: {
      "orders_v1:101": {
        id: 101,
        full_name: "Ada Lovelace",
        stock_qty: 50,
        _row_ver: 1,
        _lc: "{}",
      },
    },
  };
  const snapAfter = {
    orders_v1: {
      "orders_v1:101": {
        id: 101,
        full_name: "Ada King",
        stock_qty: 47,
        _row_ver: 2,
        _lc: '{"tax_jurisdiction":"PY-ASU","billing_tier":"enterprise"}',
      },
    },
  };
  const diffs = diffSnapshots(snapBefore, snapAfter, { orders_v1: "id" });

  // 3. pgcow: Measure Copy-on-Write / hardlink snapshot clone speed on a real SQLite/PG state directory
  const tmpBase = os.tmpdir();
  const tmpSrc = path.join(tmpBase, "sq_hotroll_cow_src");
  const tmpDst = path.join(tmpBase, "sq_hotroll_cow_dst");
  fs.rmSync(tmpSrc, { recursive: true, force: true });
  fs.rmSync(tmpDst, { recursive: true, force: true });
  fs.mkdirSync(tmpSrc, { recursive: true });
  fs.writeFileSync(
    path.join(tmpSrc, "state_v1.sqlite"),
    Buffer.alloc(1024 * 256, 0x42)
  );
  const cowResult = await cowCloneDir(tmpSrc, tmpDst);
  fs.rmSync(tmpSrc, { recursive: true, force: true });
  fs.rmSync(tmpDst, { recursive: true, force: true });

  // 4. flaredump: Capture a mid-flight schema-skew HTTP 500 replay from Baseline B1/A1 vs 200 OK in SQ-HotRoll
  const capturedReplays: Array<{ error?: { message?: string } }> = [];
  const wrappedB1Handler = withFlareDump(
    async (req: Request) => {
      const epoch = req.headers.get("X-D1-Schema-Epoch") ?? "1";
      if (epoch === "1") {
        return new Response(
          JSON.stringify({ error: "D1_ERROR: no such column: full_name" }),
          { status: 500 }
        );
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
    {
      onCapture: (r: { error?: { message?: string } }) =>
        capturedReplays.push(r),
    }
  );
  const resB1 = await wrappedB1Handler(
    new Request("https://edge.example.com/api/orders", {
      method: "POST",
      headers: { "X-D1-Schema-Epoch": "1", "Sec-Fetch-Mode": "cors" },
      body: JSON.stringify({ full_name: "Grace Hopper", qty: 2 }),
    }),
    { ENVIRONMENT: "production" },
    {}
  );

  // 5. wrangler-doctor: Run cf-migrate audit on a synthetic migration directory
  const tmpProj = path.join(tmpBase, "sq_hotroll_wd_proj");
  fs.rmSync(tmpProj, { recursive: true, force: true });
  fs.mkdirSync(path.join(tmpProj, "migrations"), { recursive: true });
  fs.writeFileSync(
    path.join(tmpProj, "wrangler.toml"),
    `name = "sq-hotroll-worker"\ncompatibility_date = "2026-10-01"\n[[d1_databases]]\nbinding = "DB"\ndatabase_name = "orders-db"\ndatabase_id = "00000000-0000-0000-0000-000000000001"\n`
  );
  const wdFindings = checkCfMigrate(tmpProj, null);
  fs.rmSync(tmpProj, { recursive: true, force: true });

  return {
    pg_lock_xray: {
      b0_critical_count: xrayB0.criticalCount,
      b0_lock_modes: xrayB0.statements.map(
        (s: { lockMode: string }) => s.lockMode
      ),
      sq_critical_count: xraySq.criticalCount,
      rewritten_lines: fixPreview.rewritten.split("\n").length,
    },
    dbwatch: {
      captured_row_changes: diffs.length,
      sample_op: diffs[0]?.op ?? "none",
      preserved_lc: Boolean(
        (diffs[0]?.after as Record<string, unknown>)?._lc
      ),
    },
    pgcow: {
      clone_method: cowResult.method,
      clone_elapsed_ms: Number(cowResult.elapsedMs.toFixed(4)),
    },
    flaredump: {
      b1_skew_status: resB1.status,
      captured_replays_count: capturedReplays.length,
      captured_error: capturedReplays[0]?.error?.message ?? "",
    },
    wrangler_doctor: {
      findings_count: wdFindings.length,
    },
  };
}

if (import.meta.main) {
  const out = await runPortfolioProbes();
  const outPath = path.join(PROJECT_ROOT, "results", "raw", "portfolio_probes.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
}
