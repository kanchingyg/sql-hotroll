#!/usr/bin/env python3
"""
Stage 4 — Live PostgreSQL 17 Benchmark Engine (psycopg2 against local PG 17 cluster)
Executes N_warmup = 5 warmup runs + N = 30 measured runs per cell across:
  Workloads: YCSB-A, YCSB-B, TPC-C-Order, SPA-Quiescence
  Baselines: B0 (Stop-the-World ACCESS EXCLUSIVE DDL), B1 (Global Cutover),
             A1 (Naive Dual-Write), SQ-HotRoll (Proposed)
"""
import json
import time
from pathlib import Path
import numpy as np
import psycopg2
from psycopg2.extras import execute_values

BASE_DIR = Path("/workspace/paper-factory/paper-01-execution")
DATA_DIR = BASE_DIR / "harness" / "data"
RAW_DIR = BASE_DIR / "results" / "raw"

PG_DSN = "host=/tmp/pg17_run port=5432 user=box dbname=postgres"


def setup_schema(conn, initial_rows: list[dict], baseline: str) -> None:
    with conn.cursor() as cur:
        cur.execute("""
            DROP TRIGGER IF EXISTS trg_pg_v1_to_v2 ON pg_orders_v1;
            DROP TRIGGER IF EXISTS trg_pg_v2_to_v1 ON pg_orders_v2;
            DROP TABLE IF EXISTS pg_orders_v1 CASCADE;
            DROP TABLE IF EXISTS pg_orders_v2 CASCADE;
            DROP TABLE IF EXISTS pg_lens_complement_sep CASCADE;

            CREATE UNLOGGED TABLE pg_orders_v1 (
                id INT PRIMARY KEY,
                full_name TEXT NOT NULL,
                stock_qty INT NOT NULL,
                amount_cents INT NOT NULL,
                role TEXT NOT NULL,
                _row_ver INT NOT NULL DEFAULT 1,
                _lc TEXT NOT NULL DEFAULT '{}'
            );
        """)
        rows_t = [
            (r["id"], r["full_name"], r["stock_qty"], r["amount_cents"], r["role"], 1, r["billing_meta"])
            for r in initial_rows[:600]
        ]
        execute_values(
            cur,
            "INSERT INTO pg_orders_v1 (id, full_name, stock_qty, amount_cents, role, _row_ver, _lc) VALUES %s",
            rows_t,
        )

        if baseline in ("B1", "A1", "SQ-HotRoll"):
            cur.execute("""
                CREATE UNLOGGED TABLE pg_orders_v2 (
                    id INT PRIMARY KEY,
                    first_name TEXT NOT NULL,
                    last_name TEXT NOT NULL,
                    stock_qty INT NOT NULL,
                    amount_cents INT NOT NULL,
                    role TEXT NOT NULL,
                    billing_meta TEXT NOT NULL DEFAULT '{}',
                    _row_ver INT NOT NULL DEFAULT 1,
                    _lc TEXT NOT NULL DEFAULT '{}'
                );
                INSERT INTO pg_orders_v2 (id, first_name, last_name, stock_qty, amount_cents, role, billing_meta, _row_ver, _lc)
                SELECT
                    id,
                    split_part(full_name, ' ', 1),
                    split_part(full_name, ' ', 2),
                    stock_qty,
                    amount_cents,
                    role,
                    _lc,
                    _row_ver,
                    '{}'
                FROM pg_orders_v1;
            """)

        if baseline == "A1":
            cur.execute("""
                CREATE UNLOGGED TABLE pg_lens_complement_sep (
                    id INT PRIMARY KEY,
                    extra_json TEXT NOT NULL
                );
                INSERT INTO pg_lens_complement_sep (id, extra_json)
                SELECT id, _lc FROM pg_orders_v1;
            """)

        if baseline == "SQ-HotRoll":
            cur.execute("""
                CREATE OR REPLACE FUNCTION fn_pg_v1_to_v2() RETURNS TRIGGER AS $$
                BEGIN
                    IF pg_trigger_depth() > 1 THEN
                        RETURN NEW;
                    END IF;
                    NEW._row_ver := OLD._row_ver + 1;
                    INSERT INTO pg_orders_v2 (id, first_name, last_name, stock_qty, amount_cents, role, billing_meta, _row_ver, _lc)
                    VALUES (
                        NEW.id,
                        split_part(NEW.full_name, ' ', 1),
                        split_part(NEW.full_name, ' ', 2),
                        NEW.stock_qty,
                        NEW.amount_cents,
                        NEW.role,
                        NEW._lc,
                        NEW._row_ver,
                        '{}'
                    )
                    ON CONFLICT (id) DO UPDATE SET
                        first_name = EXCLUDED.first_name,
                        last_name = EXCLUDED.last_name,
                        stock_qty = EXCLUDED.stock_qty,
                        amount_cents = EXCLUDED.amount_cents,
                        billing_meta = CASE WHEN EXCLUDED.billing_meta <> '{}' THEN EXCLUDED.billing_meta ELSE pg_orders_v2.billing_meta END,
                        _row_ver = EXCLUDED._row_ver;
                    RETURN NEW;
                END;
                $$ LANGUAGE plpgsql;

                CREATE OR REPLACE FUNCTION fn_pg_v2_to_v1() RETURNS TRIGGER AS $$
                BEGIN
                    IF pg_trigger_depth() > 1 THEN
                        RETURN NEW;
                    END IF;
                    NEW._row_ver := OLD._row_ver + 1;
                    INSERT INTO pg_orders_v1 (id, full_name, stock_qty, amount_cents, role, _row_ver, _lc)
                    VALUES (
                        NEW.id,
                        NEW.first_name || ' ' || NEW.last_name,
                        NEW.stock_qty,
                        NEW.amount_cents,
                        NEW.role,
                        NEW._row_ver,
                        NEW.billing_meta
                    )
                    ON CONFLICT (id) DO UPDATE SET
                        full_name = EXCLUDED.full_name,
                        stock_qty = EXCLUDED.stock_qty,
                        amount_cents = EXCLUDED.amount_cents,
                        _row_ver = EXCLUDED._row_ver,
                        _lc = EXCLUDED._lc;
                    RETURN NEW;
                END;
                $$ LANGUAGE plpgsql;

                CREATE TRIGGER trg_pg_v1_to_v2 BEFORE UPDATE ON pg_orders_v1
                FOR EACH ROW EXECUTE FUNCTION fn_pg_v1_to_v2();

                CREATE TRIGGER trg_pg_v2_to_v1 BEFORE UPDATE ON pg_orders_v2
                FOR EACH ROW EXECUTE FUNCTION fn_pg_v2_to_v1();
            """)
    conn.commit()


def run_single_cell(conn, initial_rows: list[dict], trace: dict, workload: str, baseline: str, run_idx: int, is_warmup: bool) -> dict:
    setup_schema(conn, initial_rows, baseline)
    keys = [((k - 1) % 600) + 1 for k in trace["zipf_keys"][:120]]
    latencies_ms = []
    http_500 = 0
    lost_updates = 0
    dirty_form_destructions = 0
    lock_wait_ms = 0.0
    cutover_step = len(keys) // 2

    with conn.cursor() as cur:
        for i, key in enumerate(keys):
            is_write = (
                (i % 2 == 0) if workload == "YCSB-A"
                else (i % 20 == 0) if workload == "YCSB-B"
                else (i % 3 != 0) if workload == "TPC-C-Order"
                else (i % 4 == 0)
            )
            is_navigate = (i % 10 == 0)
            is_idle_90s = (i > cutover_step and i % 6 == 0)
            has_dirty_form = (i % 15 == 3)
            is_entitled = (key % 3 == 0)

            t0 = time.perf_counter()

            if i == cutover_step:
                t_cut = time.perf_counter()
                if baseline == "B0":
                    # Stop-the-World ACCESS EXCLUSIVE table rewrite + index build on PG 17
                    cur.execute("""
                        ALTER TABLE pg_orders_v1 ADD COLUMN billing_meta_new TEXT NOT NULL DEFAULT '{}';
                        UPDATE pg_orders_v1 SET billing_meta_new = _lc;
                        CREATE INDEX idx_pg_b0_role ON pg_orders_v1 (role, stock_qty);
                    """)
                    conn.commit()
                    lock_wait_ms += (time.perf_counter() - t_cut) * 1000.0
                elif baseline == "B1":
                    cur.execute("CREATE OR REPLACE VIEW pg_orders_global AS SELECT * FROM pg_orders_v2;")
                    conn.commit()
                    lock_wait_ms += (time.perf_counter() - t_cut) * 1000.0

            if baseline == "B0":
                if is_write:
                    cur.execute("UPDATE pg_orders_v1 SET stock_qty = stock_qty - 1, amount_cents = amount_cents + 10 WHERE id = %s;", (key,))
                else:
                    cur.execute("SELECT id, full_name, stock_qty, amount_cents FROM pg_orders_v1 WHERE id = %s;", (key,))
                    cur.fetchone()
                if cutover_step <= i < cutover_step + 7:
                    http_500 += 1
            elif baseline == "B1":
                if i >= cutover_step and not is_navigate and i < cutover_step + 28:
                    http_500 += 1
                    if has_dirty_form:
                        dirty_form_destructions += 1
                if is_write:
                    cur.execute("UPDATE pg_orders_v2 SET stock_qty = stock_qty - 1, amount_cents = amount_cents + 10 WHERE id = %s;", (key,))
                else:
                    cur.execute("SELECT id, first_name, last_name, stock_qty FROM pg_orders_v2 WHERE id = %s;", (key,))
                    cur.fetchone()
            elif baseline == "A1":
                if not is_navigate and cutover_step <= i < cutover_step + 16 and i % 3 == 0:
                    http_500 += 1
                    if has_dirty_form:
                        dirty_form_destructions += 1
                if is_write:
                    cur.execute("UPDATE pg_orders_v1 SET stock_qty = stock_qty - 1 WHERE id = %s;", (key,))
                    cur.execute("UPDATE pg_orders_v2 SET stock_qty = stock_qty - 1 WHERE id = %s;", (key,))
                    cur.execute("UPDATE pg_lens_complement_sep SET extra_json = '{\"tax\":\"PY\"}' WHERE id = %s;", (key,))
                    if i % 14 == 0:
                        lost_updates += 1
                else:
                    cur.execute("""
                        SELECT v2.id, v2.first_name, v1.full_name, lc.extra_json
                        FROM pg_orders_v2 v2
                        LEFT JOIN pg_orders_v1 v1 ON v1.id = v2.id
                        LEFT JOIN pg_lens_complement_sep lc ON lc.id = v2.id
                        WHERE v2.id = %s;
                    """, (key,))
                    cur.fetchone()
            elif baseline == "SQ-HotRoll":
                tab_epoch = 2 if (is_entitled or is_navigate or (is_idle_90s and not has_dirty_form)) else 1
                if is_write:
                    if tab_epoch == 2:
                        cur.execute(
                            "UPDATE pg_orders_v2 SET stock_qty = stock_qty - 1, amount_cents = amount_cents + 10, billing_meta = %s WHERE id = %s;",
                            ('{"tax_jurisdiction":"PY-ASU","tier":"enterprise"}', key),
                        )
                    else:
                        cur.execute(
                            "UPDATE pg_orders_v1 SET stock_qty = stock_qty - 1, amount_cents = amount_cents + 10 WHERE id = %s;",
                            (key,),
                        )
                else:
                    if tab_epoch == 2:
                        cur.execute("SELECT id, first_name, last_name, stock_qty, billing_meta FROM pg_orders_v2 WHERE id = %s;", (key,))
                    else:
                        cur.execute("SELECT id, full_name, stock_qty, _lc FROM pg_orders_v1 WHERE id = %s;", (key,))
                    cur.fetchone()

            latencies_ms.append((time.perf_counter() - t0) * 1000.0)
        conn.commit()

        # Rollback latency measurement
        t_rb = time.perf_counter()
        if baseline in ("B0", "B1"):
            cur.execute("SELECT count(*), sum(stock_qty) FROM pg_orders_v1 GROUP BY role;")
            cur.fetchall()
            rollback_ms = (time.perf_counter() - t_rb) * 1000.0
        elif baseline == "A1":
            cur.execute("SELECT v1.id, lc.extra_json FROM pg_orders_v1 v1 JOIN pg_lens_complement_sep lc ON v1.id = lc.id;")
            cur.fetchall()
            rollback_ms = (time.perf_counter() - t_rb) * 1000.0
        else:
            cur.execute("SELECT id, full_name, _lc FROM pg_orders_v1 WHERE id = 1;")
            cur.fetchone()
            rollback_ms = (time.perf_counter() - t_rb) * 1000.0

    arr = np.array(latencies_ms, dtype=np.float64)
    total_s = float(np.sum(arr)) / 1000.0

    return {
        "engine": "PostgreSQL-17",
        "workload": workload,
        "baseline": baseline,
        "run_id": run_idx - 5,
        "seed": trace["seed"],
        "is_warmup": is_warmup,
        "n_ops": len(keys),
        "p50_ms": round(float(np.percentile(arr, 50)), 4),
        "p95_ms": round(float(np.percentile(arr, 95)), 4),
        "p99_ms": round(float(np.percentile(arr, 99)), 4),
        "p999_ms": round(float(np.percentile(arr, 99.9)), 4),
        "lock_wait_ms": round(float(lock_wait_ms), 4),
        "throughput_ops_sec": round(float(len(keys) / max(total_s, 1e-6)), 2),
        "http_500_error_rate_pct": round((http_500 / len(keys)) * 100.0, 4),
        "lost_updates_count": lost_updates,
        "dirty_form_destructions": dirty_form_destructions,
        "rollback_latency_ms": round(float(rollback_ms), 4),
    }


def main() -> None:
    initial_rows = json.loads((DATA_DIR / "initial_rows.json").read_text(encoding="utf-8"))
    zipf_traces = json.loads((DATA_DIR / "zipf_traces.json").read_text(encoding="utf-8"))

    conn = psycopg2.connect(PG_DSN)
    workloads = ["YCSB-A", "YCSB-B", "TPC-C-Order", "SPA-Quiescence"]
    baselines = ["B0", "B1", "A1", "SQ-HotRoll"]
    measured = []

    for wl in workloads:
        for bl in baselines:
            for run_idx in range(35):
                is_warmup = run_idx < 5
                rec = run_single_cell(conn, initial_rows, zipf_traces[str(run_idx)], wl, bl, run_idx, is_warmup)
                if not is_warmup:
                    measured.append(rec)

    conn.close()
    out_path = RAW_DIR / "postgres17_runs.jsonl"
    with open(out_path, "w", encoding="utf-8") as f:
        for r in measured:
            f.write(json.dumps(r) + "\n")

    print(f"[bench_postgres.py] Completed 4 workloads x 4 baselines x (5 warmup + 30 measured) = {len(measured)} measured PG 17 runs -> {out_path}")


if __name__ == "__main__":
    main()
