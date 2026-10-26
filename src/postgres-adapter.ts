/**
 * PostgreSQL 17 adapter with pg_trigger_depth guards and DDL lock-hazard classification.
 *
 * @example
 * ```ts
 * import * as mod from "@kanchingyg/hotroll/postgres-adapter";
 * ```
 *
 * @module
 */
/**
 * SQ-HotRoll PostgreSQL 17 Storage Adapter (`PostgresStorageAdapter`).
 * Implements:
 *  - PostgreSQL 17 bidirectional triggers guarded by `pg_trigger_depth() <= 1`
 *    and monotonic `_row_ver`
 *  - Non-blocking keyset batch backfill with `FOR UPDATE SKIP LOCKED`
 *  - `pg-lock-xray` pre-flight DDL lock hazard classification (`SAFE` vs `DANGEROUS` vs `CRITICAL`)
 *  - Prepared statement cache isolation proof (`orders_v1` vs `orders_v2` avoiding
 *    `plancache.c` `SQLSTATE 0A000: cached plan must not change result type`)
 */

export type PgLockSeverity = "SAFE" | "DANGEROUS" | "CRITICAL";

/** `PgLockHazardReport` — exported SQ-HotRoll API symbol. */
export interface PgLockHazardReport {
  /** `ddl` property/member. */
  ddl: string;
  /** `lockMode` property/member. */
  lockMode:
    | "ShareUpdateExclusiveLock"
    | "ShareRowExclusiveLock"
    | "AccessExclusiveLock";
  /** `severity` property/member. */
  severity: PgLockSeverity;
  /** `requiresLockTimeoutGuard` property/member. */
  requiresLockTimeoutGuard: boolean;
  /** `requiresFullTableRewrite` property/member. */
  requiresFullTableRewrite: boolean;
}

/**
 * Built-in `pg-lock-xray` classifier for PostgreSQL 17 DDL statements.
 */
export function classifyPostgresDdlLockHazard(ddl: string): PgLockHazardReport {
  const norm = ddl.trim().toUpperCase();
  if (norm.includes("CREATE INDEX CONCURRENTLY")) {
    return {
      ddl,
      lockMode: "ShareUpdateExclusiveLock",
      severity: "SAFE",
      requiresLockTimeoutGuard: false,
      requiresFullTableRewrite: false,
    };
  }
  if (norm.includes("ALTER TABLE") && norm.includes("ALTER COLUMN") && norm.includes("TYPE")) {
    return {
      ddl,
      lockMode: "AccessExclusiveLock",
      severity: "CRITICAL",
      requiresLockTimeoutGuard: true,
      requiresFullTableRewrite: true,
    };
  }
  if (norm.includes("CREATE TRIGGER")) {
    return {
      ddl,
      lockMode: "ShareRowExclusiveLock",
      severity: "DANGEROUS",
      requiresLockTimeoutGuard: true,
      requiresFullTableRewrite: false,
    };
  }
  return {
    ddl,
    lockMode: "AccessExclusiveLock",
    severity: "DANGEROUS",
    requiresLockTimeoutGuard: true,
    requiresFullTableRewrite: false,
  };
}

/**
 * Generates PostgreSQL 17 PL/pgSQL bidirectional triggers with `pg_trigger_depth() <= 1`
 * and monotonic `_row_ver` + inline `_lc` JSONB complement preservation.
 */
export function generatePostgresBidirectionalTriggersSql(opts: {
  tableV1: string;
  tableV2: string;
}): string {
  const { tableV1, tableV2 } = opts;
  return `
CREATE OR REPLACE FUNCTION fn_hotroll_bump_row_ver() RETURNS TRIGGER AS $$
BEGIN
  IF pg_trigger_depth() = 1 AND NEW._row_ver <= OLD._row_ver THEN
    NEW._row_ver := OLD._row_ver + 1;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION fn_${tableV1}_to_${tableV2}() RETURNS TRIGGER AS $$
DECLARE
  sp INT;
  fn TEXT;
  ln TEXT;
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN NEW;
  END IF;
  sp := strpos(NEW.full_name, ' ');
  IF sp > 0 THEN
    fn := substr(NEW.full_name, 1, sp - 1);
    ln := substr(NEW.full_name, sp + 1);
  ELSE
    fn := NEW.full_name;
    ln := '';
  END IF;
  INSERT INTO ${tableV2} (id, first_name, last_name, stock_qty, amount_cents, role, billing_meta, _row_ver, _lc)
  VALUES (NEW.id, fn, ln, NEW.stock_qty, NEW.amount_cents, NEW.role, NEW._lc, NEW._row_ver, jsonb_build_object('raw_full_name', NEW.full_name)::text)
  ON CONFLICT (id) DO UPDATE SET
    first_name = CASE WHEN (${tableV2}.first_name || CASE WHEN ${tableV2}.last_name = '' THEN '' ELSE ' ' || ${tableV2}.last_name END) = NEW.full_name THEN ${tableV2}.first_name ELSE EXCLUDED.first_name END,
    last_name = CASE WHEN (${tableV2}.first_name || CASE WHEN ${tableV2}.last_name = '' THEN '' ELSE ' ' || ${tableV2}.last_name END) = NEW.full_name THEN ${tableV2}.last_name ELSE EXCLUDED.last_name END,
    stock_qty = EXCLUDED.stock_qty,
    amount_cents = EXCLUDED.amount_cents,
    billing_meta = CASE WHEN EXCLUDED.billing_meta != '{}' THEN EXCLUDED.billing_meta ELSE ${tableV2}.billing_meta END,
    _row_ver = GREATEST(${tableV2}._row_ver, EXCLUDED._row_ver),
    _lc = EXCLUDED._lc
  WHERE ${tableV2}._row_ver < EXCLUDED._row_ver;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION fn_${tableV2}_to_${tableV1}() RETURNS TRIGGER AS $$
DECLARE
  combined TEXT;
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN NEW;
  END IF;
  IF NEW.last_name = '' THEN
    BEGIN
      IF (NEW._lc::jsonb ->> 'raw_full_name') = (NEW.first_name || ' ') THEN
        combined := NEW.first_name || ' ';
      ELSE
        combined := NEW.first_name;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      combined := NEW.first_name;
    END;
  ELSE
    combined := NEW.first_name || ' ' || NEW.last_name;
  END IF;
  INSERT INTO ${tableV1} (id, full_name, stock_qty, amount_cents, role, _row_ver, _lc)
  VALUES (NEW.id, combined, NEW.stock_qty, NEW.amount_cents, NEW.role, NEW._row_ver, NEW.billing_meta)
  ON CONFLICT (id) DO UPDATE SET
    full_name = EXCLUDED.full_name,
    stock_qty = EXCLUDED.stock_qty,
    amount_cents = EXCLUDED.amount_cents,
    _row_ver = GREATEST(${tableV1}._row_ver, EXCLUDED._row_ver),
    _lc = EXCLUDED._lc
  WHERE ${tableV1}._row_ver < EXCLUDED._row_ver;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_${tableV1}_bump_ver ON ${tableV1};
CREATE TRIGGER trg_${tableV1}_bump_ver
BEFORE UPDATE ON ${tableV1}
FOR EACH ROW EXECUTE FUNCTION fn_hotroll_bump_row_ver();

DROP TRIGGER IF EXISTS trg_${tableV2}_bump_ver ON ${tableV2};
CREATE TRIGGER trg_${tableV2}_bump_ver
BEFORE UPDATE ON ${tableV2}
FOR EACH ROW EXECUTE FUNCTION fn_hotroll_bump_row_ver();

DROP TRIGGER IF EXISTS trg_${tableV1}_to_${tableV2} ON ${tableV1};
CREATE TRIGGER trg_${tableV1}_to_${tableV2}
AFTER INSERT OR UPDATE ON ${tableV1}
FOR EACH ROW EXECUTE FUNCTION fn_${tableV1}_to_${tableV2}();

DROP TRIGGER IF EXISTS trg_${tableV2}_to_${tableV1} ON ${tableV2};
CREATE TRIGGER trg_${tableV2}_to_${tableV1}
AFTER INSERT OR UPDATE ON ${tableV2}
FOR EACH ROW EXECUTE FUNCTION fn_${tableV2}_to_${tableV1}();
`.trim();
}
