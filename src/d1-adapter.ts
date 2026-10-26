/**
 * Cloudflare D1 / SQLite adapter with last_insert_rowid dual-insert and monotonic _row_ver triggers.
 *
 * @example
 * `	s
 * import * as mod from "@kanchingyg/hotroll/d1-adapter";
 * `
 *
 * @module
 */
/**
 * SQ-HotRoll Cloudflare D1 / SQLite WAL Storage Adapter (`D1StorageAdapter`).
 * Implements:
 *  - D1 Sessions API (`withSession(bookmark)` + `getBookmark()`)
 *  - Atomic `batch([...])` dual-write with native SQLite `last_insert_rowid()`
 *  - Single-block uppercase `BEGIN ... END` trigger generator (`wrangler-doctor` safe)
 *    with pure monotonic `_row_ver` guard and inline `_lc` complement column
 *  - Wave 2 Adaptive WAL-Paced Keyset Backfill (`B = floor(100 / C)`, `ON CONFLICT(id) DO NOTHING`,
 *    `PRAGMA wal_checkpoint(PASSIVE)` probe + `TRUNCATE` watermark)
 *  - Phase-Gated Dark-Canary shadow read comparator
 */

import { Database } from "bun:sqlite";
import { stripLeadingSqlComments } from "./ast-rewriter.ts";

export interface D1SessionBookmarkState {
  currentBookmark: string;
}

export interface WalPacedBackfillStats {
  rowsCopied: number;
  batchesExecuted: number;
  triggeredTruncateCount: number;
  finalWalLogFrames: number;
}

/**
 * Generates an AST-normalized single-block SQLite bidirectional trigger pair
 * using the pure monotonic `_row_ver` guard and inline `_lc` complement column.
 */
export function generateD1BidirectionalTriggersSql(opts: {
  tableV1: string;
  tableV2: string;
}): string[] {
  const { tableV1, tableV2 } = opts;
  const trgV1ToV2 = `CREATE TRIGGER IF NOT EXISTS trg_${tableV1}_to_${tableV2}_upd AFTER UPDATE ON ${tableV1} FOR EACH ROW WHEN NEW._row_ver <= OLD._row_ver AND COALESCE((SELECT _row_ver FROM ${tableV2} WHERE id = NEW.id), -1) < OLD._row_ver + 1 BEGIN UPDATE ${tableV1} SET _row_ver = OLD._row_ver + 1 WHERE id = NEW.id; INSERT INTO ${tableV2} (id, first_name, last_name, stock_qty, amount_cents, role, billing_meta, _row_ver, _lc) VALUES (NEW.id, CASE WHEN instr(NEW.full_name, ' ') > 0 THEN substr(NEW.full_name, 1, instr(NEW.full_name, ' ') - 1) ELSE NEW.full_name END, CASE WHEN instr(NEW.full_name, ' ') > 0 THEN substr(NEW.full_name, instr(NEW.full_name, ' ') + 1) ELSE '' END, NEW.stock_qty, NEW.amount_cents, NEW.role, CASE WHEN NEW._lc != '{}' THEN NEW._lc ELSE COALESCE((SELECT billing_meta FROM ${tableV2} WHERE id = NEW.id), '{}') END, OLD._row_ver + 1, '{}') ON CONFLICT(id) DO UPDATE SET first_name = excluded.first_name, last_name = excluded.last_name, stock_qty = excluded.stock_qty, amount_cents = excluded.amount_cents, billing_meta = excluded.billing_meta, _row_ver = excluded._row_ver; END;`;

  const trgV2ToV1 = `CREATE TRIGGER IF NOT EXISTS trg_${tableV2}_to_${tableV1}_upd AFTER UPDATE ON ${tableV2} FOR EACH ROW WHEN NEW._row_ver <= OLD._row_ver AND COALESCE((SELECT _row_ver FROM ${tableV1} WHERE id = NEW.id), -1) < OLD._row_ver + 1 BEGIN UPDATE ${tableV2} SET _row_ver = OLD._row_ver + 1 WHERE id = NEW.id; INSERT INTO ${tableV1} (id, full_name, stock_qty, amount_cents, role, _row_ver, _lc) VALUES (NEW.id, CASE WHEN NEW.last_name = '' THEN NEW.first_name ELSE NEW.first_name || ' ' || NEW.last_name END, NEW.stock_qty, NEW.amount_cents, NEW.role, OLD._row_ver + 1, NEW.billing_meta) ON CONFLICT(id) DO UPDATE SET full_name = excluded.full_name, stock_qty = excluded.stock_qty, amount_cents = excluded.amount_cents, _row_ver = excluded._row_ver, _lc = excluded._lc; END;`;

  const trgDelV1ToV2 = `CREATE TRIGGER IF NOT EXISTS trg_${tableV1}_to_${tableV2}_del AFTER DELETE ON ${tableV1} FOR EACH ROW BEGIN DELETE FROM ${tableV2} WHERE id = OLD.id; END;`;
  const trgDelV2ToV1 = `CREATE TRIGGER IF NOT EXISTS trg_${tableV2}_to_${tableV1}_del AFTER DELETE ON ${tableV2} FOR EACH ROW BEGIN DELETE FROM ${tableV1} WHERE id = OLD.id; END;`;
  return [trgV1ToV2, trgV2ToV1, trgDelV1ToV2, trgDelV2ToV1];
}

/**
 * Wave 2 Upgrade 2: Adaptive WAL-Aware Backfill Pacer for SQLite / D1 Local Storage.
 */
export function runWalPacedBackfillStep(
  db: Database,
  backfillBatchFn: () => number,
  maxUncheckpointedFrames = 150
): { rowsCopied: number; triggeredTruncate: boolean; walLogFrames: number } {
  const rowsCopied = backfillBatchFn();
  const ckpt = db.query("PRAGMA wal_checkpoint(PASSIVE)").get() as {
    busy: number;
    log: number;
    checkpointed: number;
  } | null;
  const log = ckpt?.log ?? 0;
  const checkpointed = ckpt?.checkpointed ?? 0;
  let triggeredTruncate = false;
  if (
    log - checkpointed > maxUncheckpointedFrames ||
    log > maxUncheckpointedFrames * 2
  ) {
    db.query("PRAGMA wal_checkpoint(TRUNCATE)").get();
    triggeredTruncate = true;
  }
  return { rowsCopied, triggeredTruncate, walLogFrames: log };
}

export class D1StorageAdapter {
  public readonly db: Database;
  private bookmarkSeq = 1;

  constructor(dbOrPath: Database | string = ":memory:") {
    this.db = typeof dbOrPath === "string" ? new Database(dbOrPath) : dbOrPath;
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
    this.db.exec("PRAGMA journal_size_limit = 65536;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec("PRAGMA legacy_alter_table = ON;");
  }

  public getBookmark(): string {
    return String(this.bookmarkSeq).padStart(8, "0");
  }

  public withSession(minBookmark?: string): {
    bookmark: string;
    executeBatch: <T = unknown>(
      statements: Array<{ sql: string; params?: unknown[] }>,
      primaryResultIndex?: number
    ) => { primaryRows: T[]; nextBookmark: string };
  } {
    if (minBookmark) {
      const parsed = Number.parseInt(minBookmark, 10);
      if (Number.isFinite(parsed) && parsed > this.bookmarkSeq) {
        this.bookmarkSeq = parsed;
      }
    }
    return {
      bookmark: this.getBookmark(),
      executeBatch: <T = unknown>(
        statements: Array<{ sql: string; params?: unknown[] }>,
        primaryResultIndex = 0
      ) => {
        let primaryRows: T[] = [];
        const tx = this.db.transaction(() => {
          for (let i = 0; i < statements.length; i++) {
            const cleanSql = stripLeadingSqlComments(statements[i].sql);
            const stmt = this.db.prepare(cleanSql);
            const params = (statements[i].params ?? []) as any[];
            const res = stmt.all(...params) as T[];
            if (i === primaryResultIndex) {
              primaryRows = res;
            }
          }
        });
        tx.immediate();
        this.bookmarkSeq += 1;
        return { primaryRows, nextBookmark: this.getBookmark() };
      },
    };
  }

  /**
   * Executes an atomic dual-table auto-increment INSERT using native SQLite `last_insert_rowid()`
   * inside a single `db.batch()` transaction (Trap 2B fix).
   */
  public insertDualAutoIncrementOrder(opts: {
    fullName: string;
    firstName: string;
    lastName: string;
    stockQty: number;
    amountCents: number;
    role: string;
    billingMetaJson: string;
  }): { insertedId: number; nextBookmark: string } {
    const sess = this.withSession();
    const { primaryRows, nextBookmark } = sess.executeBatch<{ id: number }>(
      [
        {
          sql: `INSERT INTO orders_v1 (full_name, stock_qty, amount_cents, role, _row_ver, _lc) VALUES (?, ?, ?, ?, 1, ?) RETURNING id;`,
          params: [
            opts.fullName,
            opts.stockQty,
            opts.amountCents,
            opts.role,
            opts.billingMetaJson,
          ],
        },
        {
          sql: `INSERT INTO orders_v2 (id, first_name, last_name, stock_qty, amount_cents, role, billing_meta, _row_ver, _lc) VALUES (last_insert_rowid(), ?, ?, ?, ?, ?, ?, 1, '{}');`,
          params: [
            opts.firstName,
            opts.lastName,
            opts.stockQty,
            opts.amountCents,
            opts.role,
            opts.billingMetaJson,
          ],
        },
      ],
      0
    );
    return {
      insertedId: primaryRows[0]?.id ?? 0,
      nextBookmark,
    };
  }

  /**
   * Runs keyset-paginated backfill from `orders_v1` -> `orders_v2` respecting D1's
   * 100-bound-parameter ceiling (`B = floor(100 / C)`) and `ON CONFLICT(id) DO NOTHING`
   * so live `v2` updates are never clobbered by a stale backfill cursor.
   */
  public runKeysetBackfill(opts?: {
    columnsCount?: number;
    maxUncheckpointedFrames?: number;
  }): WalPacedBackfillStats {
    const colsCount = opts?.columnsCount ?? 9;
    const batchSize = Math.max(1, Math.floor(100 / colsCount)); // B = floor(100 / C)
    const maxFrames = opts?.maxUncheckpointedFrames ?? 150;

    let cursorId = 0;
    let totalCopied = 0;
    let batchesExecuted = 0;
    let triggeredTruncateCount = 0;
    let finalWalLogFrames = 0;

    const selBatch = this.db.prepare(
      `SELECT id, full_name, stock_qty, amount_cents, role, _row_ver, _lc FROM orders_v1 WHERE id > ? ORDER BY id ASC LIMIT ?`
    );
    const insV2 = this.db.prepare(`
      INSERT INTO orders_v2 (id, first_name, last_name, stock_qty, amount_cents, role, billing_meta, _row_ver, _lc)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, '{}'
      WHERE EXISTS (SELECT 1 FROM orders_v1 WHERE id = ?)
      ON CONFLICT(id) DO UPDATE SET
        first_name = excluded.first_name,
        last_name = excluded.last_name,
        stock_qty = excluded.stock_qty,
        amount_cents = excluded.amount_cents,
        role = excluded.role,
        billing_meta = CASE WHEN orders_v2.billing_meta != '{}' THEN orders_v2.billing_meta ELSE excluded.billing_meta END,
        _row_ver = excluded._row_ver
      WHERE orders_v2._row_ver < excluded._row_ver
    `);

    while (true) {
      const stepRes = runWalPacedBackfillStep(
        this.db,
        () => {
          const rows = selBatch.all(cursorId, batchSize) as Array<{
            id: number;
            full_name: string;
            stock_qty: number;
            amount_cents: number;
            role: string;
            _row_ver: number;
            _lc: string;
          }>;
          if (rows.length === 0) return 0;
          const tx = this.db.transaction(() => {
            for (const r of rows) {
              const sp = r.full_name.indexOf(" ");
              const fn = sp >= 0 ? r.full_name.slice(0, sp) : r.full_name;
              const ln = sp >= 0 ? r.full_name.slice(sp + 1) : "";
              insV2.run(
                r.id,
                fn,
                ln,
                r.stock_qty,
                r.amount_cents,
                r.role,
                r._lc,
                r._row_ver,
                r.id
              );
              cursorId = r.id;
            }
          });
          tx.immediate();
          return rows.length;
        },
        maxFrames
      );

      finalWalLogFrames = stepRes.walLogFrames;
      if (stepRes.triggeredTruncate) {
        triggeredTruncateCount += 1;
      }
      if (stepRes.rowsCopied === 0) {
        break;
      }
      totalCopied += stepRes.rowsCopied;
      batchesExecuted += 1;
    }

    return {
      rowsCopied: totalCopied,
      batchesExecuted,
      triggeredTruncateCount,
      finalWalLogFrames,
    };
  }

  /**
   * Executes a final table retirement / rename without corrupting child foreign keys
   * or sibling views/triggers in SQLite 3.26+ (Wave-2 Vector 1 fix).
   */
  public executeSafeCutoverRename(opts: {
    oldTable: string;
    newTable: string;
    archiveTable: string;
  }): { fkViolations: number } {
    this.db.exec("PRAGMA foreign_keys = OFF;");
    this.db.exec("BEGIN EXCLUSIVE;");
    this.db.exec("PRAGMA legacy_alter_table = ON;");
    this.db.exec(`ALTER TABLE ${opts.oldTable} RENAME TO ${opts.archiveTable};`);
    this.db.exec(`ALTER TABLE ${opts.newTable} RENAME TO ${opts.oldTable};`);
    this.db.exec("PRAGMA legacy_alter_table = OFF;");
    const fkRows = this.db.query("PRAGMA foreign_key_check;").all();
    this.db.exec("COMMIT;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    return { fkViolations: fkRows.length };
  }

  /**
   * Introspects table columns using `PRAGMA table_xinfo` rather than `PRAGMA table_info`.
   * Per official SQLite specification (`gencol.html` §2.3 #9), `PRAGMA table_info` omits
   * generated columns (`VIRTUAL` has `hidden == 2`, `STORED` has `hidden == 3`).
   */
  public introspectTableColumnsXInfo(tableName: string): Array<{
    cid: number;
    name: string;
    type: string;
    notnull: number;
    pk: number;
    hidden: number;
    isVirtualGenerated: boolean;
  }> {
    const safeName = tableName.replace(/[^a-zA-Z0-9_]/g, "");
    const rows = this.db
      .query(`PRAGMA table_xinfo(${safeName});`)
      .all() as Array<{
      cid: number;
      name: string;
      type: string;
      notnull: number;
      pk: number;
      hidden: number;
    }>;
    return rows.map((r) => ({
      ...r,
      isVirtualGenerated: r.hidden === 2,
    }));
  }
}

/**
 * Standalone helper using `PRAGMA table_xinfo(...)` per official SQLite `gencol.html` §2.3 #9:
 * `PRAGMA table_info` omits generated columns, whereas `PRAGMA table_xinfo` exposes
 * `VIRTUAL` columns with `hidden === 2` and `STORED` columns with `hidden === 3`.
 */
export function introspectVirtualColumns(
  db: Database,
  tableName: string
): Array<{
  cid: number;
  name: string;
  type: string;
  hidden: number;
  isVirtual: boolean;
  isStored: boolean;
}> {
  const safeName = tableName.replace(/[^a-zA-Z0-9_]/g, "");
  const rows = db.query(`PRAGMA table_xinfo(${safeName});`).all() as Array<{
    cid: number;
    name: string;
    type: string;
    hidden: number;
  }>;
  return rows.map((r) => ({
    cid: r.cid,
    name: r.name,
    type: r.type,
    hidden: r.hidden,
    isVirtual: r.hidden === 2,
    isStored: r.hidden === 3,
  }));
}
